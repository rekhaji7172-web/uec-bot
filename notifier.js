const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ApplicationCommandOptionType, ChannelType } = require('discord.js');
const E = require('./emojis');
const STATS = require('./stats');

const OWNER_ID = '1414507047277301833';
const FILE = path.join(__dirname, 'notifiers.json');
const POLL_MS = Number(process.env.NOTIFIER_POLL_MS) > 0 ? Number(process.env.NOTIFIER_POLL_MS) : 60 * 1000;
const COLOR = 0xff0000;
const MAX_NEW_PER_CYCLE = 3;
const MAX_FAILS = 10;

const MENTION_CONTENT = {
  both: '@everyone @here',
  everyone: '@everyone',
  here: '@here',
  none: '',
};
const MENTION_PARSE = {
  both: ['everyone', 'here'],
  everyone: ['everyone'],
  here: ['here'],
  none: [],
};
const MENTION_LABEL = {
  both: '@everyone + @here',
  everyone: '@everyone',
  here: '@here',
  none: 'no ping',
};

const state = { nextId: 1, items: [] };
let loaded = false;
let ticking = false;

function load() {
  loaded = true;
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      state.items = raw.items;
      state.nextId = Number(raw.nextId) || state.items.length + 1;
    }
  } catch (err) {
    console.error('[notifier] failed to load notifiers.json:', err.message);
  }
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function ensureLoaded() {
  if (!loaded) load();
}

function one(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function resolveYouTube(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('Give me a YouTube video, channel or @handle link.');
  const target = STATS.resolveTarget(input);
  if (!target || (!target.channelId && !target.videoId && !target.handle && !target.legacy)) {
    throw new Error('That does not look like a YouTube link. Paste a video link, channel link or @handle.');
  }

  if (STATS.ytKey()) {
    try {
      if (target.videoId) {
        const j = await STATS.ytApi('videos', { part: 'snippet', id: target.videoId });
        const sn = j.items && j.items[0] && j.items[0].snippet;
        if (sn && sn.channelId) return { channelId: sn.channelId, channelTitle: sn.channelTitle || null };
      } else if (target.channelId) {
        const j = await STATS.ytApi('channels', { part: 'snippet', id: target.channelId });
        const it = j.items && j.items[0];
        if (it) return { channelId: it.id, channelTitle: (it.snippet && it.snippet.title) || null };
      } else if (target.handle) {
        const j = await STATS.ytApi('channels', { part: 'snippet', forHandle: '@' + target.handle });
        const it = j.items && j.items[0];
        if (it) return { channelId: it.id, channelTitle: (it.snippet && it.snippet.title) || null };
      }
    } catch {
      // fall through to scraping
    }
  }

  let channelId = target.channelId || null;
  if (!channelId && target.videoId) {
    const html = await STATS.fetchText(`https://www.youtube.com/watch?v=${target.videoId}`).catch(() => '');
    channelId = one(html, /"channelId":"(UC[\w-]{22})"/) || one(html, /"externalId":"(UC[\w-]{22})"/);
  }
  if (!channelId && (target.handle || target.legacy)) {
    const url = target.handle
      ? `https://www.youtube.com/@${target.handle}`
      : `https://www.youtube.com/c/${target.legacy}`;
    const html = await STATS.fetchText(url).catch(() => '');
    channelId = one(html, /"externalId":"(UC[\w-]{22})"/) || one(html, /"channelId":"(UC[\w-]{22})"/);
  }
  if (!channelId) throw new Error('Could not read that YouTube link — make sure it is a public channel or video.');
  return { channelId, channelTitle: null };
}

async function fetchFeed(channelId) {
  const xml = await STATS.fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  let channelTitle = one(xml, /<media:display name><!\[CDATA\[([\s\S]*?)\]\]><\/media:display name>/);
  if (!channelTitle) {
    const m = xml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    channelTitle = m ? m[1].trim() : null;
  }
  if (channelTitle) channelTitle = unescapeXml(channelTitle);
  const entries = xml
    .split('<entry>')
    .slice(1)
    .map((e) => ({
      id: one(e, /<yt:videoId>([\w-]{11})<\/yt:videoId>/),
      title: unescapeXml((one(e, /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || '').trim()),
      published: one(e, /<published>([^<]+)<\/published>/),
    }))
    .filter((x) => x.id);
  return { channelTitle: channelTitle || null, entries };
}

function buildVideoEmbed(item, video, channelTitle) {
  const url = `https://www.youtube.com/watch?v=${video.id}`;
  const ts = video.published ? Math.floor(Date.parse(video.published) / 1000) : Math.floor(Date.now() / 1000);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${E.rocket} Just Posted!`)
    .setURL(url)
    .setDescription(`**[${video.title || 'New video'}](${url})**`)
    .addFields(
      { name: `${E.user} Channel`, value: channelTitle || item.ytTitle || 'YouTube', inline: true },
      { name: `${E.clock} Posted`, value: `<t:${ts}:f> (<t:${ts}:R>)`, inline: true }
    )
    .setThumbnail(`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`)
    .setFooter({ text: 'YouTube Notifier' });
}

async function pauseAfterFails(client, item) {
  item.enabled = false;
  console.error(`[notifier #${item.id}] auto-paused after ${MAX_FAILS} failures`);
  client.users
    .fetch(OWNER_ID)
    .then((u) =>
      u.send(
        `${E.warning} Notifier #${item.id} (${item.ytTitle}) was auto-paused — it failed to post ${MAX_FAILS} times. Fix the channel and resume it with \`/pausenotifier\`.`
      )
    )
    .catch(() => {});
}

async function postVideo(client, item, video, channelTitle) {
  const ch = await client.channels.fetch(item.targetId).catch(() => null);
  if (!ch) {
    item.fails = (item.fails || 0) + 1;
    console.warn(`[notifier #${item.id}] cannot access channel ${item.targetId} (${item.fails}/${MAX_FAILS})`);
    if (item.fails >= MAX_FAILS && item.enabled) await pauseAfterFails(client, item);
    return false;
  }
  try {
    await ch.send({
      content: MENTION_CONTENT[item.mention] || undefined,
      embeds: [buildVideoEmbed(item, video, channelTitle)],
      allowedMentions: { parse: MENTION_PARSE[item.mention] || [], repliedUser: false },
    });
    item.fails = 0;
    return true;
  } catch (err) {
    item.fails = (item.fails || 0) + 1;
    console.error(`[notifier #${item.id}] send failed (${item.fails}/${MAX_FAILS}):`, err.message);
    if (item.fails >= MAX_FAILS && item.enabled) await pauseAfterFails(client, item);
    return false;
  }
}

async function tick(client) {
  if (ticking) return;
  ticking = true;
  try {
    for (const item of state.items) {
      if (!item.enabled) continue;
      try {
        const feed = await fetchFeed(item.ytChannelId);
        if (!feed.entries.length) continue;
        if (feed.channelTitle && feed.channelTitle !== item.ytTitle) item.ytTitle = feed.channelTitle;
        if (!item.lastVideoId || !item.lastPublished) {
          item.lastVideoId = feed.entries[0].id;
          item.lastPublished = feed.entries[0].published || new Date().toISOString();
          save();
          continue;
        }
        const lastT = Date.parse(item.lastPublished) || 0;
        const fresh = feed.entries.filter(
          (e) => e.id !== item.lastVideoId && (Date.parse(e.published) || 0) >= lastT
        );
        if (!fresh.length) continue;
        const toPost = fresh.slice(0, MAX_NEW_PER_CYCLE).reverse();
        for (const v of toPost) {
          const ok = await postVideo(client, item, v, feed.channelTitle);
          if (!ok) break;
          item.lastVideoId = v.id;
          item.lastPublished = v.published || new Date().toISOString();
          save();
        }
        save();
      } catch (err) {
        console.error(`[notifier #${item.id}]`, err.message);
      }
    }
  } finally {
    ticking = false;
  }
}

function start(client) {
  ensureLoaded();
  const active = state.items.filter((i) => i.enabled).length;
  if (state.items.length) {
    console.log(`YouTube notifiers: ${state.items.length} total, ${active} active`);
  }
  setInterval(() => {
    tick(client).catch((err) => console.error('[notifier tick]', err.message));
  }, POLL_MS);
}

const idOption = {
  type: ApplicationCommandOptionType.String,
  name: 'id',
  description: 'Notifier ID (from /notifiers)',
  required: true,
  autocomplete: true,
};

const COMMANDS = [
  {
    name: 'addnotifier',
    description: 'Set up a YouTube upload notifier (owner only)',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'url',
        description: 'YouTube video, channel or @handle link',
        required: true,
      },
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'channel',
        description: 'Discord channel to post notifications in (default: this channel)',
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      },
      {
        type: ApplicationCommandOptionType.String,
        name: 'mention',
        description: 'Who to ping when a video drops (default: @everyone + @here)',
        choices: [
          { name: '@everyone + @here', value: 'both' },
          { name: '@everyone only', value: 'everyone' },
          { name: '@here only', value: 'here' },
          { name: 'No ping', value: 'none' },
        ],
      },
    ],
  },
  { name: 'notifiers', description: 'List all YouTube notifiers (owner only)' },
  {
    name: 'removenotifier',
    description: 'Remove a YouTube notifier (owner only)',
    options: [idOption],
  },
  {
    name: 'setmention',
    description: 'Change the ping for a notifier (owner only)',
    options: [
      idOption,
      {
        type: ApplicationCommandOptionType.String,
        name: 'mode',
        description: 'Who to ping',
        required: true,
        choices: [
          { name: '@everyone + @here', value: 'both' },
          { name: '@everyone only', value: 'everyone' },
          { name: '@here only', value: 'here' },
          { name: 'No ping', value: 'none' },
        ],
      },
    ],
  },
  {
    name: 'pausenotifier',
    description: 'Pause or resume a notifier (owner only)',
    options: [idOption],
  },
];

const NAMES = new Set(COMMANDS.map((c) => c.name));

function ownerOnlyEmbed() {
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${E.warning} Owner only`)
    .setDescription('Only my owner can manage YouTube notifiers.');
}

function errorEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`${E.warning} Oops`)
    .setDescription(String(message).slice(0, 1000));
}

async function sendError(interaction, err) {
  const emb = errorEmbed(err && err.message ? err.message : 'Something went wrong.');
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [emb] }).catch(() => {});
  } else {
    await interaction.reply({ embeds: [emb], ephemeral: true }).catch(() => {});
  }
}

function findItem(id) {
  return state.items.find((i) => i.id === String(id)) || null;
}

async function handleInteraction(interaction) {
  if (!NAMES.has(interaction.commandName)) return false;
  ensureLoaded();

  if (interaction.user.id !== OWNER_ID) {
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => {});
    } else {
      await interaction.reply({ embeds: [ownerOnlyEmbed()], ephemeral: true }).catch(() => {});
    }
    return true;
  }

  if (interaction.isAutocomplete()) {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const nameOf = (id) => {
      const ch = interaction.client.channels.cache.get(id);
      return ch ? ch.name : '?';
    };
    const choices = state.items
      .filter(
        (i) =>
          !focused || i.id.startsWith(focused) || String(i.ytTitle || '').toLowerCase().includes(focused)
      )
      .slice(0, 25)
      .map((i) => ({
        name: `#${i.id} ${i.ytTitle} → #${nameOf(i.targetId)}`.slice(0, 100),
        value: i.id,
      }));
    await interaction.respond(choices).catch(() => {});
    return true;
  }

  try {
    const name = interaction.commandName;

    if (name === 'addnotifier') {
      await interaction.deferReply({ ephemeral: true });
      const raw = interaction.options.getString('url', true);
      const mention = interaction.options.getString('mention') || 'both';
      const picked = interaction.options.getChannel('channel');
      const wantedId = (picked && picked.id) || (interaction.channel && interaction.channel.id);
      if (!interaction.guild) throw new Error('Use this command inside a server.');
      if (!wantedId) {
        throw new Error("I can't access this channel — use the `channel` option to pick one I can post in.");
      }
      const target = await interaction.client.channels.fetch(wantedId).catch(() => null);
      if (!target) {
        throw new Error(`I can't access <#${wantedId}> — make sure I can view that channel, or pick another.`);
      }
      if (target.type !== ChannelType.GuildText && target.type !== ChannelType.GuildAnnouncement) {
        throw new Error('Pick a text or announcement channel for notifications.');
      }
      const me = interaction.guild.members.me;
      const perms = target.permissionsFor(me);
      if (perms && (!perms.has('ViewChannel') || !perms.has('SendMessages'))) {
        throw new Error(
          `I can't post in <#${target.id}> — I need **View Channel** and **Send Messages** there. Fix my permissions or pick another channel.`
        );
      }
      const { channelId, channelTitle } = await resolveYouTube(raw);
      const feed = await fetchFeed(channelId);
      if (!feed.entries.length) {
        throw new Error('That channel has no public videos — notifier not added.');
      }
      if (state.items.some((i) => i.ytChannelId === channelId && i.targetId === target.id)) {
        throw new Error('A notifier for this channel already posts in that channel. Check /notifiers.');
      }
      const ytTitle = channelTitle || feed.channelTitle || 'YouTube Channel';
      const item = {
        id: String(state.nextId++),
        ytChannelId: channelId,
        ytTitle,
        source: raw,
        guildId: interaction.guildId,
        targetId: target.id,
        mention,
        enabled: true,
        lastVideoId: feed.entries[0].id,
        lastPublished: feed.entries[0].published || new Date().toISOString(),
        fails: 0,
        addedAt: Date.now(),
      };
      state.items.push(item);
      save();

      const noPingWarn =
        perms && !perms.has('MentionEveryone')
          ? `\n${E.warning} I don't have **Mention Everyone** permission there — the ping may not reach anyone.`
          : '';
      const emb = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle(`${E.verified} Notifier #${item.id} created`)
        .setDescription(
          [
            `${E.document} **Watching:** [${ytTitle}](https://www.youtube.com/channel/${channelId})`,
            `${E.message} **Post to:** <#${target.id}>`,
            `${E.target} **Ping:** ${MENTION_LABEL[mention]}`,
            `${E.clock} **Baseline:** notifying for uploads after “${feed.entries[0].title}”`,
          ].join('\n') + noPingWarn
        );
      await interaction.editReply({ embeds: [emb] });
      return true;
    }

    if (name === 'notifiers') {
      if (!state.items.length) {
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`${E.menu} YouTube Notifiers`)
              .setDescription(`No notifiers yet — use \`/addnotifier\`.`),
          ],
          ephemeral: true,
        });
        return true;
      }
      const nameOf = (id) => {
        const ch = interaction.client.channels.cache.get(id);
        return ch ? `#${ch.name}` : `<#${id}>`;
      };
      const lines = state.items.map((i) => {
        const status = i.enabled ? `${E.okay} active` : '⏸ paused';
        return `**#${i.id}** — ${i.ytTitle} → ${nameOf(i.targetId)} • ping: ${MENTION_LABEL[i.mention]} • ${status}`;
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`${E.menu} YouTube Notifiers (${state.items.length})`)
            .setDescription(lines.join('\n').slice(0, 4000)),
        ],
        ephemeral: true,
      });
      return true;
    }

    if (name === 'removenotifier') {
      const id = interaction.options.getString('id', true);
      const idx = state.items.findIndex((i) => i.id === String(id));
      if (idx === -1) throw new Error(`Notifier #${id} not found — see /notifiers.`);
      const [removed] = state.items.splice(idx, 1);
      save();
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle(`${E.verified} Notifier #${removed.id} removed`)
            .setDescription(`Stopped watching **${removed.ytTitle}**.`),
        ],
        ephemeral: true,
      });
      return true;
    }

    if (name === 'setmention') {
      const id = interaction.options.getString('id', true);
      const mode = interaction.options.getString('mode', true);
      const item = findItem(id);
      if (!item) throw new Error(`Notifier #${id} not found — see /notifiers.`);
      item.mention = mode;
      save();
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle(`${E.verified} Notifier #${item.id} updated`)
            .setDescription(`New videos will now ping **${MENTION_LABEL[mode]}** in <#${item.targetId}>.`),
        ],
        ephemeral: true,
      });
      return true;
    }

    if (name === 'pausenotifier') {
      const id = interaction.options.getString('id', true);
      const item = findItem(id);
      if (!item) throw new Error(`Notifier #${id} not found — see /notifiers.`);
      item.enabled = !item.enabled;
      if (item.enabled) item.fails = 0;
      save();
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(item.enabled ? 0x57f287 : 0xfee75c)
            .setTitle(`${item.enabled ? E.verified + ' Resumed' : '⏸ Paused'} — Notifier #${item.id}`)
            .setDescription(`${item.ytTitle} → <#${item.targetId}>`),
        ],
        ephemeral: true,
      });
      return true;
    }
  } catch (err) {
    await sendError(interaction, err);
  }
  return true;
}

module.exports = {
  COMMANDS,
  handleInteraction,
  start,
  resolveYouTube,
  fetchFeed,
};
