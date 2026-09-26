const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const E = require('./emojis');

const H = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const COLOR_YT = 0xff0000;
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
  return String(v).replace(/\s*views?$/i, '').trim();
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

async function getChannelStats(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase();
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

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
  const acChunk = acIdx === -1 ? '' : about.slice(acIdx, acIdx + 2000);
  channelId = one(acChunk, /"channelId":"(UC[\w-]{22})"/) || rssUrl || channelId;
  const description = jstr(one(acChunk, /"description":"((?:[^"\\]|\\.)*)"/));
  const subs = one(acChunk, /"subscriberCountText":"([^"]+)"/);
  const totalViews = one(acChunk, /"viewCountText":"([^"]+)"/);
  const joinedRaw = one(acChunk, /"joinedDateText":\{"content":"([^"]+)"/);
  const joined = joinedRaw ? joinedRaw.replace(/^Joined\s+/i, '') : null;
  const canonical = one(acChunk, /"canonicalChannelUrl":"([^"]+)"/);

  const handleFromUrl = canonical && canonical.includes('/@') ? canonical.split('/@')[1] : null;
  const handle = target.handle || handleFromUrl;
  const channelUrl = handle ? `https://www.youtube.com/@${handle}` : `https://www.youtube.com/channel/${channelId}`;

  const avatar = one(about, /"avatar":\{"thumbnails":\[\{"url":"(https:\/\/yt3[^"]+)"/);

  const videosUrl = channelId
    ? `https://www.youtube.com/channel/${channelId}/videos`
    : `https://www.youtube.com/@${handle}/videos`;
  const videosHtml = await fetchText(videosUrl);

  let videoCount = pickVideoCount(about, subs);
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
  const latest = recent[0] || null;

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
    videoCount: videoCount ? `${videoCount} videos` : null,
    latest,
    top: top || [],
    sharedVideo,
    fetchedAt: Date.now(),
  };

  CACHE.set(key, { at: Date.now(), data });
  return data;
}

function videoLine(v) {
  const title = (v.title || 'Untitled').replace(/[[\]()`*_|]/g, '').slice(0, 70);
  const views = cleanViews(v.views);
  const when = v.when ? ` • ${v.when}` : '';
  return `[\`${title}\`](https://www.youtube.com/watch?v=${v.id})${views ? ` — **${views} views**${when}` : ''}`;
}

function buildChannelEmbed(s) {
  const topOne = s.top && s.top[0];

  const embed = new EmbedBuilder()
    .setColor(COLOR_YT)
    .setTitle(`${E.search} ${s.name} — YouTube Stats`)
    .setURL(s.url)
    .setFooter({ text: 'UECBOT • YouTube stats • updated every 10 min' })
    .setTimestamp();

  if (s.avatar) embed.setThumbnail(s.avatar);

  const bio = s.description
    ? s.description.replace(/\s+/g, ' ').trim().slice(0, 220)
    : null;
  if (bio) embed.setDescription(bio.length >= 220 ? bio + '…' : bio);

  embed.addFields(
    { name: `${E.user} Subscribers`, value: s.subs || 'N/A', inline: true },
    { name: `${E.document} Total Videos`, value: s.videoCount || 'N/A', inline: true },
    { name: `${E.view} Total Views`, value: s.totalViews || 'N/A', inline: true },
    { name: `${E.clock} Joined YouTube`, value: s.joined || 'N/A', inline: true }
  );

  if (s.latest) {
    embed.addFields({
      name: `${E.rightarrow} Latest Upload`,
      value: videoLine(s.latest),
      inline: false,
    });
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

  if (topOne) {
    embed.addFields({
      name: `${E.target} Most Viewed Video`,
      value: videoLine(topOne),
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
        .setURL(`https://www.youtube.com/watch?v=${s.latest.id}`)
    );
  }
  if (s.top[0]) {
    row.addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Most Viewed')
        .setURL(`https://www.youtube.com/watch?v=${s.top[0].id}`)
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
        '▸ `/ask [question]` or `!ask [question]` — start chat, then press **Start Chat**',
        '▸ After starting, just type your questions in that channel',
        '▸ `!end` — end your chat session',
        '',
        `${E.clock} **AFK System**`,
        '▸ `!afk [reason]` — go AFK, auto-removed when someone mentions you',
        '',
        `${E.view} **Stats**`,
        '▸ `!stats` — this server\'s stats',
        '▸ `!stats <youtube link>` — full channel analysis',
        '▸ `/stats [url]` — slash version',
        '',
        `${E.okay} **Other**`,
        '▸ `!help` or `/help` — this list',
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
};
