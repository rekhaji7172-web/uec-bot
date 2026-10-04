const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const E = require('./emojis');

const H = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const COLOR_YT = 0xe500e5;
const COLOR_HELP = 0x5865f2;

function one(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function jstr(s) {
  if (!s) return null;
  try {
    return JSON.parse('"' + s + '"');
  } catch {
    return s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

async function fetchText(url, opts) {
  const res = await fetch(url, opts ? { headers: H, ...opts } : { headers: H });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseLockups(text, limit = 30) {
  const segs = text.split('"lockupViewModel":{').slice(1);
  const out = [];
  for (const seg of segs) {
    const id = one(seg, /"contentId":"([\w-]{11})"/);
    if (!id) continue;
    const title = jstr(one(seg, /"title":\{"content":"((?:[^"\\]|\\.)*)"/));
    const mp = seg.indexOf('"metadataParts":[');
    let views = null;
    let when = null;
    if (mp !== -1) {
      const chunks = [...seg.slice(mp, mp + 600).matchAll(/"content":"([^"]+)"/g)].map((m) => m[1]);
      views = chunks[0] || null;
      when = chunks[1] || null;
    }
    out.push({ id, title, views, when });
    if (out.length >= limit) break;
  }
  return out;
}

function viewsToNum(v) {
  if (!v) return -1;
  const m = String(v)
    .replace(/views?/i, '')
    .trim()
    .match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!m) return -1;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n)) return -1;
  const s = (m[2] || '').toUpperCase();
  if (s === 'K') n *= 1e3;
  if (s === 'M') n *= 1e6;
  if (s === 'B') n *= 1e9;
  return n;
}

function cleanViews(v) {
  if (!v) return null;
  if (typeof v === 'number') return fmtViewsNum(v);
  return String(v).replace(/\s*views?$/i, '').trim();
}

function fmtViewsNum(n) {
  if (n == null || isNaN(n)) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function xmlUnescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseShorts(html) {
  const segs = html.split('"shortsLockupViewModel":{').slice(1);
  const out = [];
  for (const seg of segs) {
    const id =
      one(seg, /"entityId":"shorts-shelf-item-([\w-]{11})"/) || one(seg, /"videoId":"([\w-]{11})"/);
    if (!id || out.some((o) => o.id === id)) continue;
    let title = null;
    let views = null;
    const acc = one(seg, /"accessibilityText":"((?:[^"\\]|\\.)*)"/);
    if (acc) {
      const text = jstr(acc);
      const m = text.match(/^(.*),\s*([\d.,]+)\s*(thousand|million|billion)?\s*views?\s*[–-]\s*play Short\s*$/i);
      if (m) {
        title = m[1].trim();
        let n = parseFloat(m[2].replace(/,/g, ''));
        if (m[3]) n *= { thousand: 1e3, million: 1e6, billion: 1e9 }[m[3].toLowerCase()];
        views = Math.round(n);
      }
    }
    if (!title) title = jstr(one(seg, /"title":\{"content":"((?:[^"\\]|\\.)*)"/));
    if (!title) continue;
    out.push({ id, title, views });
    if (out.length >= 12) break;
  }
  return out;
}

async function fetchShortsList(handle, channelId) {
  try {
    const url = handle
      ? `https://www.youtube.com/@${handle}/shorts`
      : `https://www.youtube.com/channel/${channelId}/shorts`;
    return parseShorts(await fetchText(url));
  } catch {
    return [];
  }
}

async function fetchRssList(channelId) {
  try {
    const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    return xml
      .split('<entry>')
      .slice(1, 15)
      .map((e) => ({
        id: one(e, /<yt:videoId>([\w-]{11})<\/yt:videoId>/),
        title: xmlUnescape(one(e, /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || '').trim(),
        published: one(e, /<published>([^<]+)<\/published>/),
      }))
      .filter((x) => x.id);
  } catch {
    return [];
  }
}

function ytKey() {
  return String(process.env.YOUTUBE_API_KEY || '').trim() || null;
}

async function ytApi(endpoint, params) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  u.searchParams.set('key', ytKey());
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, v);
  }
  const res = await fetch(u);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    throw new Error(`YT API ${res.status}: ${j.error ? j.error.message : 'error'}`);
  }
  return j;
}

function iso8601Seconds(d) {
  if (!d) return 0;
  const m = String(d).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

async function apiGetChannel(params) {
  const j = await ytApi('channels', { part: 'snippet,statistics,contentDetails', ...params });
  const c = j.items && j.items[0];
  if (!c) return null;
  const sn = c.snippet || {};
  const st = c.statistics || {};
  const thumbs = sn.thumbnails || {};
  const avatar = (thumbs.high || thumbs.medium || thumbs.default || {}).url || null;
  return {
    id: c.id,
    title: sn.title || 'YouTube Channel',
    customUrl: sn.customUrl || null,
    description: sn.description || null,
    avatar,
    subscriberCount:
      st.subscriberCount && !st.hiddenSubscriberCount
        ? Number(st.subscriberCount).toLocaleString('en-US')
        : null,
    totalViews: st.viewCount ? Number(st.viewCount).toLocaleString('en-US') : null,
    videoCount: st.videoCount ? Number(st.videoCount).toLocaleString('en-US') : null,
    joined: sn.publishedAt
      ? new Date(sn.publishedAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : null,
    uploads: (c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads) || null,
  };
}

async function apiVideos(ids) {
  if (!ids.length) return [];
  const j = await ytApi('videos', {
    part: 'snippet,statistics,contentDetails',
    id: ids.slice(0, 50).join(','),
  });
  return (j.items || []).map((v) => {
    const sn = v.snippet || {};
    return {
      id: v.id,
      channelId: sn.channelId || null,
      title: sn.title || 'Untitled video',
      date: sn.publishedAt || null,
      views: v.statistics && v.statistics.viewCount != null ? Number(v.statistics.viewCount) : null,
      duration: iso8601Seconds(v.contentDetails && v.contentDetails.duration),
    };
  });
}

async function apiPlaylistItems(uploadsPlaylistId, max = 50) {
  const j = await ytApi('playlistItems', {
    part: 'snippet,contentDetails',
    playlistId: uploadsPlaylistId,
    maxResults: String(max),
  });
  return (j.items || [])
    .map((it) => {
      const cd = it.contentDetails || {};
      const sn = it.snippet || {};
      return {
        id: cd.videoId || (cd.resourceId && cd.resourceId.videoId) || null,
        title: cd.title || sn.title || null,
        date: cd.videoPublishedAt || sn.publishedAt || null,
      };
    })
    .filter((x) => x.id);
}

async function apiMostViewed(channelId) {
  const j = await ytApi('search', {
    part: 'snippet',
    channelId,
    type: 'video',
    order: 'viewCount',
    maxResults: '1',
  });
  const item = j.items && j.items[0];
  const id = item && item.id && item.id.videoId;
  if (!id) return null;
  const [d] = await apiVideos([id]);
  if (d) {
    return {
      id: d.id,
      title: d.title,
      views: d.views,
      date: d.date,
      when: null,
      isShort: d.duration > 0 && d.duration < 61,
    };
  }
  const sn = item.snippet || {};
  return {
    id,
    title: sn.title || 'Untitled video',
    views: null,
    date: sn.publishedAt || null,
    when: null,
    isShort: false,
  };
}

async function apiChannelStats(raw) {
  const target = resolveTarget(raw);
  if (!target || (!target.handle && !target.channelId && !target.videoId)) {
    throw new Error('That does not look like a YouTube channel link.');
  }
  if (target.legacy) throw new Error('legacy username channel');

  let channelId = target.channelId || null;
  let sharedVideo = null;

  const loadVideo = async (id) => {
    const [v] = await apiVideos([id]);
    if (!v || !v.channelId) return false;
    channelId = v.channelId;
    sharedVideo = { id: v.id, title: v.title, views: v.views, date: v.date, seconds: v.duration };
    return true;
  };

  if (target.videoId && !(await loadVideo(target.videoId))) {
    throw new Error('Could not read that YouTube video link.');
  }

  let ch = null;
  if (channelId) {
    ch = await apiGetChannel({ id: channelId });
  } else if (target.handle) {
    ch = await apiGetChannel({ forHandle: '@' + target.handle });
    if (!ch && target.bare11 && (await loadVideo(target.bare11))) {
      ch = await apiGetChannel({ id: channelId });
    }
  }
  if (!ch) throw new Error('YouTube channel not found. Check the link.');

  channelId = ch.id;
  const handle = (ch.customUrl || '').replace(/^@/, '') || null;

  let details = [];
  if (ch.uploads) {
    try {
      const items = await apiPlaylistItems(ch.uploads, 50);
      if (items.length) details = await apiVideos(items.map((i) => i.id));
    } catch {
      details = [];
    }
  }

  const shorts = details
    .filter((v) => v.duration > 0 && v.duration < 61)
    .map((v) => ({ id: v.id, title: v.title, views: v.views }));

  const first = details[0] || null;
  const latest = first
    ? {
        id: first.id,
        title: first.title,
        date: first.date,
        when: null,
        views: first.views,
        isShort: first.duration > 0 && first.duration < 61,
      }
    : null;

  let top = [];
  try {
    const mv = await apiMostViewed(channelId);
    if (mv) top = [mv];
  } catch {
    top = [];
  }
  if (!top.length && details.length) {
    top = [...details]
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 3)
      .map((v) => ({
        id: v.id,
        title: v.title,
        views: v.views,
        date: v.date,
        when: null,
        isShort: v.duration > 0 && v.duration < 61,
      }));
  }

  return {
    name: ch.title,
    handle,
    channelId,
    url: handle ? `https://www.youtube.com/@${handle}` : `https://www.youtube.com/channel/${channelId}`,
    avatar: ch.avatar,
    description: ch.description || null,
    subs: ch.subscriberCount,
    totalViews: ch.totalViews,
    joined: ch.joined,
    videoCount: ch.videoCount,
    latest,
    top,
    shorts,
    sharedVideo,
    source: 'api',
    fetchedAt: Date.now(),
  };
}

function resolveTarget(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^<|>$/g, '');
  if (!s) return null;

  if (/^@[\w.-]{1,}$/.test(s)) return { handle: s.slice(1) };
  if (/^UC[\w-]{22}$/.test(s)) return { channelId: s };
  if (/^[\w-]{11}$/.test(s)) return { handle: s, bare11: s };
  if (/^[\w.-]{2,40}$/.test(s)) return { handle: s };

  let u;
  try {
    u = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtu.be' && host !== 'music.youtube.com') {
    return null;
  }

  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? { videoId: id } : null;
  }
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return { videoId: v };

  const seg = u.pathname.split('/').filter(Boolean);
  if (!seg.length) return { handle: null };
  if (seg[0] === 'shorts' && /^[\w-]{11}$/.test(seg[1] || '')) return { videoId: seg[1] };
  if (seg[0] === 'live' && /^[\w-]{11}$/.test(seg[1] || '')) return { videoId: seg[1] };
  if (seg[0].startsWith('@')) {
    if ((seg[1] === 'shorts' || seg[1] === 'live') && /^[\w-]{11}$/.test(seg[2] || '')) {
      return { videoId: seg[2] };
    }
    return { handle: seg[0].slice(1) };
  }
  if (seg[0] === 'channel' && seg[1]) return { channelId: seg[1] };
  if ((seg[0] === 'c' || seg[0] === 'user') && seg[1]) return { legacy: seg[1] };
  if (seg[0] === 'watch') return null;
  return { handle: seg[0] };
}

function normSubs(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function pickVideoCount(html, subs) {
  if (!html || !subs) return null;
  const want = normSubs(subs);
  let i = -1;
  while ((i = html.indexOf('"subscriberCountText"', i + 1)) !== -1) {
    const seg = html.slice(i, i + 320);
    const plain = seg.match(/"subscriberCountText":"([^"]+)"/);
    const simple = seg.match(/"simpleText":"([^"]+)"/);
    const val = plain ? plain[1] : simple ? simple[1] : null;
    if (!val || normSubs(val) !== want) continue;
    const win = html.slice(Math.max(0, i - 400), i + 320);
    const vc =
      win.match(/"videoCountText":\{"runs":\[\{"text":"([\d,]+)"/) ||
      win.match(/"videoCount":"([\d,]+)"/);
    if (vc) return vc[1];
  }
  return null;
}

async function fetchPopular(videosHtml, channelId) {
  try {
    const token = one(videosHtml, /"text":"Popular"[\s\S]{0,600}?"continuationCommand":\{"token":"([^"]+)"/);
    const key = one(videosHtml, /"INNERTUBE_API_KEY":"([^"]+)"/);
    const ver = one(videosHtml, /"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
    const visitor = one(videosHtml, /"visitorData":"([^"]+)"/);
    if (!token || !key || !ver || !channelId) return null;

    const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': ver,
        ...H,
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'WEB', clientVersion: ver, hl: 'en', gl: 'US', visitorData: visitor },
        },
        continuation: token,
      }),
    });
    if (!res.ok) return null;
    const list = parseLockups(await res.text(), 3);
    return list.length ? list : null;
  } catch {
    return null;
  }
}

async function scrapeChannelStats(raw) {
  const target = resolveTarget(raw);
  if (!target || (!target.handle && !target.channelId && !target.videoId)) {
    throw new Error('That does not look like a YouTube channel link.');
  }

  let channelId = target.channelId || null;
  const videoId = target.videoId || null;
  let sharedVideo = null;

  const loadVideo = async (id) => {
    const watch = await fetchText(`https://www.youtube.com/watch?v=${id}`).catch(() => '');
    const cid = one(watch, /"channelId":"(UC[\w-]{22})"/);
    if (!cid) return false;
    channelId = cid;
    const vdIdx = watch.indexOf('"videoDetails":{');
    const vd = vdIdx === -1 ? '' : watch.slice(vdIdx, vdIdx + 3000);
    const vTitle = jstr(one(vd, /"title":"((?:[^"\\]|\\.)*)"/));
    const vViews = one(watch, /"viewCount":"(\d+)"/);
    const vDate = one(watch, /"publishDate":"([^"]+)"/) || one(watch, /"uploadDate":"([^"]+)"/);
    const vLen = Number(one(watch, /"lengthSeconds":"(\d+)"/) || 0);
    sharedVideo = {
      id,
      title: vTitle || 'Untitled video',
      views: vViews ? Number(vViews) : null,
      date: vDate || null,
      seconds: vLen,
    };
    return true;
  };

  if (videoId && !(await loadVideo(videoId))) {
    throw new Error('Could not read that YouTube video link.');
  }

  let aboutUrl;
  if (channelId) {
    aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
  } else if (target.handle) {
    aboutUrl = `https://www.youtube.com/@${target.handle}/about`;
  } else if (target.legacy) {
    aboutUrl = `https://www.youtube.com/c/${target.legacy}/about`;
  } else {
    throw new Error('That does not look like a YouTube channel link.');
  }

  let about = await fetchText(aboutUrl).catch(() => null);
  const aboutOk = () => about && about.includes('channelMetadataRenderer');

  if (!aboutOk() && target.bare11 && !videoId) {
    if (await loadVideo(target.bare11)) {
      aboutUrl = `https://www.youtube.com/channel/${channelId}/about`;
      about = await fetchText(aboutUrl).catch(() => null);
    }
  }
  if (!aboutOk()) {
    throw new Error('YouTube channel not found. Check the link.');
  }

  const metaIdx = about.indexOf('"channelMetadataRenderer":{');
  const metaChunk = metaIdx === -1 ? '' : about.slice(metaIdx, metaIdx + 2500);
  const name = jstr(one(metaChunk, /"title":"((?:[^"\\]|\\.)*)"/)) || 'YouTube Channel';
  const rssUrl = one(metaChunk, /"rssUrl":"https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[\w-]{22})"/);

  const acIdx = about.indexOf('"aboutChannelViewModel":{');
  const acChunk = acIdx === -1 ? '' : about.slice(acIdx, acIdx + 6000);
  channelId = one(acChunk, /"channelId":"(UC[\w-]{22})"/) || rssUrl || channelId;
  const description = jstr(one(acChunk, /"description":"((?:[^"\\]|\\.)*)"/));
  const subs = one(acChunk, /"subscriberCountText":"([^"]+)"/);
  const totalViews = one(acChunk, /"viewCountText":"([^"]+)"/);
  const joinedRaw = one(acChunk, /"joinedDateText":\{"content":"([^"]+)"/);
  const joined = joinedRaw ? joinedRaw.replace(/^Joined\s+/i, '') : null;
  const canonical = one(acChunk, /"canonicalChannelUrl":"([^"]+)"/);
  const ownVideoCount = one(acChunk, /"videoCountText":"([\d,]+) videos"/);

  const handleFromUrl = canonical && canonical.includes('/@') ? canonical.split('/@')[1] : null;
  const handle = target.handle || handleFromUrl;
  const channelUrl = handle ? `https://www.youtube.com/@${handle}` : `https://www.youtube.com/channel/${channelId}`;

  const avatar = one(about, /"avatar":\{"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/);

  const videosUrl = channelId
    ? `https://www.youtube.com/channel/${channelId}/videos`
    : `https://www.youtube.com/@${handle}/videos`;
  const [videosHtml, shorts, rss] = await Promise.all([
    fetchText(videosUrl),
    fetchShortsList(handle, channelId),
    fetchRssList(channelId),
  ]);

  let videoCount = ownVideoCount || pickVideoCount(about, subs);
  if (!videoCount) {
    const homeHtml = await fetchText(channelId ? `https://www.youtube.com/channel/${channelId}` : `https://www.youtube.com/@${handle}`).catch(() => '');
    videoCount = pickVideoCount(homeHtml, subs);
  }

  const recent = parseLockups(videosHtml, 30);
  let top = await fetchPopular(videosHtml, channelId);
  if (!top && recent.length) {
    const sorted = [...recent].sort((a, b) => viewsToNum(b.views) - viewsToNum(a.views));
    top = sorted.slice(0, 3);
  }

  let latest;
  if (rss.length) {
    const r0 = rss[0];
    const sHit = shorts.find((x) => x.id === r0.id);
    const lHit = recent.find((x) => x.id === r0.id);
    latest = {
      id: r0.id,
      title: r0.title,
      date: r0.published || null,
      when: null,
      views: sHit && sHit.views != null ? fmtViewsNum(sHit.views) : lHit ? lHit.views : null,
      isShort: Boolean(sHit),
    };
  } else if (recent[0]) {
    latest = { ...recent[0], date: null, isShort: false };
  } else if (shorts[0]) {
    latest = { ...shorts[0], date: null, when: null, isShort: true };
  } else {
    latest = null;
  }

  const data = {
    name,
    handle,
    channelId,
    url: channelUrl,
    avatar: avatar ? avatar.replace(/=s\d+.*/, '=s400') : null,
    description: description || null,
    subs: subs || null,
    totalViews: totalViews || null,
    joined: joined || null,
    videoCount: videoCount || null,
    latest,
    top: top || [],
    shorts,
    sharedVideo,
    fetchedAt: Date.now(),
  };

  return data;
}

async function getChannelStats(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  let data = null;
  if (ytKey()) {
    try {
      data = await apiChannelStats(raw);
    } catch {
      data = null;
    }
  }
  if (!data) data = await scrapeChannelStats(raw);

  CACHE.set(key, { at: Date.now(), data });
  return data;
}

function videoLine(v) {
  const title = (v.title || 'Untitled').replace(/[[\]()`*_|]/g, '').slice(0, 70);
  const views = cleanViews(v.views);
  let when = v.when ? ` • ${v.when}` : '';
  if (!when && v.date) {
    const ms = Date.parse(v.date);
    if (!isNaN(ms)) when = ` • <t:${Math.floor(ms / 1000)}:R>`;
  }
  const shortMark = v.isShort ? ` • **Short**` : '';
  const url = v.isShort
    ? `https://www.youtube.com/shorts/${v.id}`
    : `https://www.youtube.com/watch?v=${v.id}`;
  return `[\`${title}\`](${url})${views ? ` — **${views} views**` : ''}${when}${shortMark}`;
}

function buildChannelEmbed(s) {
  const shorts = (s.shorts || []).filter((v) => v && v.id);
  const shortsBest = shorts.reduce(
    (a, b) => ((b.views || 0) > ((a && a.views) || 0) ? b : a),
    null
  );
  let best = s.top && s.top[0] ? { ...s.top[0], isShort: Boolean(s.top[0].isShort) } : null;
  if (shortsBest && (!best || viewsToNum(shortsBest.views) > viewsToNum(best.views))) {
    best = { ...shortsBest, isShort: true };
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR_YT)
    .setTitle(`${E.search} ${s.name} — YouTube Stats`)
    .setURL(s.url)
    .setFooter({
      text:
        s.source === 'api'
          ? 'UECBOT • YouTube Data API • updated every 10 min'
          : 'UECBOT • YouTube stats • updated every 10 min',
    })
    .setTimestamp();

  if (s.avatar) embed.setThumbnail(s.avatar);

  const bio = s.description
    ? s.description.replace(/\s+/g, ' ').trim().slice(0, 220)
    : null;
  if (bio) embed.setDescription(bio.length >= 220 ? bio + '…' : bio);

  const channelLines = [];
  if (s.subs) channelLines.push(`> Subscribers: **${s.subs.replace(/\s*subscribers?\s*/i, '').trim()}**`);
  if (s.handle || s.channelId) channelLines.push(`> Handle: \`${s.handle ? '@' + s.handle : s.channelId}\``);
  if (s.joined) channelLines.push(`> Joined YouTube: **${s.joined}**`);
  if (channelLines.length) {
    embed.addFields({ name: `${E.user} Channel`, value: channelLines.join('\n'), inline: false });
  }

  const contentLines = [];
  if (s.videoCount) contentLines.push(`> Total videos: **${s.videoCount}**`);
  if (s.totalViews) {
    contentLines.push(`> Total views: **${s.totalViews.replace(/\s*views?\s*$/i, '').trim()}**`);
  }
  if (contentLines.length) {
    embed.addFields({ name: `${E.view} Content`, value: contentLines.join('\n'), inline: false });
  }

  if (s.latest) {
    embed.addFields({
      name: `${E.rightarrow} Latest Upload`,
      value: videoLine(s.latest),
      inline: false,
    });
  }

  if (shorts.length) {
    const lines = shorts.slice(0, 3).map((v) => {
      const title = String(v.title || 'Untitled').replace(/[[\]()`*_|]/g, '').slice(0, 70);
      const views = v.views != null ? fmtViewsNum(v.views) : null;
      return `> [\`${title}\`](https://www.youtube.com/shorts/${v.id})${views ? ` — **${views} views**` : ''}`;
    });
    embed.addFields({ name: `${E.message} Recent Shorts`, value: lines.join('\n'), inline: false });
  }

  if (s.sharedVideo) {
    const v = s.sharedVideo;
    const title = String(v.title || 'Untitled').replace(/[[\]()`*_|]/g, '').slice(0, 70);
    const bits = [];
    if (v.views != null) bits.push(`**${v.views.toLocaleString('en-US')} views**`);
    if (v.date) {
      const ms = Date.parse(v.date);
      bits.push(isNaN(ms) ? String(v.date).slice(0, 10) : `<t:${Math.floor(ms / 1000)}:D>`);
    }
    const isShort = v.seconds > 0 && v.seconds < 61;
    embed.addFields({
      name: isShort ? `${E.click} Shared Short` : `${E.click} Shared Video`,
      value: `[\`${title}\`](https://www.youtube.com/watch?v=${v.id})${bits.length ? ` — ${bits.join(' • ')}` : ''}`,
      inline: false,
    });
  }

  if (best) {
    embed.addFields({
      name: best.isShort ? `${E.target} Most Viewed Short` : `${E.target} Most Viewed Video`,
      value: videoLine(best),
      inline: false,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Channel').setURL(s.url)
  );
  if (s.latest) {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Latest Video')
        .setURL(
          s.latest.isShort
            ? `https://www.youtube.com/shorts/${s.latest.id}`
            : `https://www.youtube.com/watch?v=${s.latest.id}`
        )
    );
  }
  if (best) {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Most Viewed')
        .setURL(
          best.isShort
            ? `https://www.youtube.com/shorts/${best.id}`
            : `https://www.youtube.com/watch?v=${best.id}`
        )
    );
  }

  return { embeds: [embed], components: [row] };
}

function buildErrorEmbed(msg) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`${E.warning} Could not fetch stats`)
    .setDescription(msg || 'YouTube did not respond. Try again in a few seconds.')
    .setFooter({ text: 'UECBOT' });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function buildServerEmbed(guild, client) {
  const textChannels = guild.channels.cache.filter((c) => c.type === 0).size;
  const voiceChannels = guild.channels.cache.filter((c) => c.type === 2).size;
  const roles = guild.roles.cache.size;
  const emojis = guild.emojis.cache.size;

  return new EmbedBuilder()
    .setColor(COLOR_YT)
    .setTitle(`${E.view} ${guild.name} — Server Stats`)
    .setThumbnail(guild.iconURL({ size: 256 }))
    .addFields(
      { name: `${E.user} Members`, value: `**${guild.memberCount}**`, inline: true },
      { name: `${E.message} Text Channels`, value: `**${textChannels}**`, inline: true },
      { name: `${E.clock} Voice Channels`, value: `**${voiceChannels}**`, inline: true },
      { name: `${E.handshake} Roles`, value: `**${roles}**`, inline: true },
      {
        name: `${E.rocket} Emojis`,
        value: `**${emojis}**`,
        inline: true,
      },
      {
        name: `${E.document} Created`,
        value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`,
        inline: true,
      },
      { name: `${E.clock} Bot Uptime`, value: `**${formatUptime(client.uptime)}**`, inline: true },
      { name: `${E.target} Bot Ping`, value: `**${Math.round(client.ws.ping)} ms**`, inline: true }
    )
    .setFooter({ text: 'UECBOT • !stats <youtube link> for channel analysis' });
}

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR_HELP)
    .setTitle(`${E.menu} UECBOT — All Commands`)
    .setDescription(
      [
        `${E.document} **Scenepack Search** _(search channels only)_`,
        '▸ `list` — show all scenepacks',
        '▸ `<name>` — get a pack (e.g. `Boosfer`, `Lettuce`)',
        '▸ `/scenepack <name>` — slash version',
        '',
        `${E.rocket} **Unstable SMP AI Chat**`,
        '▸ `@bot <question>` — easiest way to call the AI',
        '▸ `/ask [question]` or `!ask [question]` — same, press **Start Chat** after',
        '▸ While chatting, mention me again for each question (e.g. `@bot who is Parrot?`)',
        '▸ `!end` — end your chat session',
        '',
        `${E.clock} **AFK System**`,
        '▸ `!afk [reason]` — go AFK, auto-removed when someone mentions you',
        '▸ `!afkstyle [on|off]` — admins: toggle AFK message style in this channel (or `#channel`)',
        '',
        `${E.view} **Stats**`,
        '▸ `!stats` — this server\'s stats',
        '▸ `!stats <youtube link>` — full channel analysis',
        '▸ `/stats [url]` — slash version',
        '',
        `${E.okay} **Other**`,
        '▸ `!help` — this list',
      ].join('\n')
    )
    .setFooter({ text: `UECBOT • Credits: discord.gg/vnjyfqN688` });
}

module.exports = {
  getChannelStats,
  buildChannelEmbed,
  buildErrorEmbed,
  buildServerEmbed,
  buildHelpEmbed,
  resolveTarget,
  fetchText,
  ytKey,
  ytApi,
};
