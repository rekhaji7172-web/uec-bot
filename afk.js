const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const E = require('./emojis');

const FILE = path.join(__dirname, 'afk.json');
const MAX_MENTIONS = 15;
const MAX_SHOWN = 10;
const NICK_PREFIX = '[AFK] ';

let state = {};
try {
  state = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
} catch {
  state = {};
}

function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch {}
}

const key = (guildId, userId) => `${guildId}:${userId}`;

function get(guildId, userId) {
  return state[key(guildId, userId)] || null;
}

function set(guildId, userId, data) {
  state[key(guildId, userId)] = data;
  save();
}

function del(guildId, userId) {
  delete state[key(guildId, userId)];
  save();
}

function trackMention(guildId, userId, entry) {
  const data = get(guildId, userId);
  if (!data) return;
  data.mentions = data.mentions || [];
  data.mentions.push(entry);
  if (data.mentions.length > MAX_MENTIONS) {
    data.mentions = data.mentions.slice(-MAX_MENTIONS);
  }
  set(guildId, userId, data);
}

async function setAfk(member, reason) {
  const guildId = member.guild.id;
  const userId = member.id;

  const existing = get(guildId, userId);
  if (existing) {
    existing.reason = reason;
    set(guildId, userId, existing);
    return existing;
  }

  let nickChanged = false;
  let originalNick = null;
  try {
    const raw = member.nickname;
    originalNick =
      raw && raw.startsWith(NICK_PREFIX) ? raw.slice(NICK_PREFIX.length).trim() || null : raw;
    const base = originalNick || member.user.displayName || member.user.username;
    let next = NICK_PREFIX + base;
    if (next.length > 32) next = next.slice(0, 32);
    await member.setNickname(next);
    nickChanged = true;
  } catch {}

  const data = {
    reason,
    since: Date.now(),
    nick: originalNick,
    nickChanged,
    mentions: [],
  };
  set(guildId, userId, data);
  return data;
}

async function clearAfk(member) {
  const guildId = member.guild.id;
  const userId = member.id;
  const data = get(guildId, userId);
  del(guildId, userId);
  if (data && data.nickChanged) {
    const target = data.nick || null;
    try {
      await member.setNickname(target);
    } catch {
      setTimeout(() => {
        try {
          member.setNickname(target).catch(() => {});
        } catch {}
      }, 4000);
    }
  }
  return data;
}

function timeAgo(ts) {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function buildSetEmbed(member, reason, data) {
  const nickLine =
    data && data.nickChanged
      ? `**Nickname:** \`[AFK] ${data.nick || member.user.displayName || member.user.username}\`\n`
      : `**Nickname:** ⚠️ _not changed — the bot needs the **Manage Nicknames** permission (AFK alerts still work)_\n`;
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`${E.clock} AFK Enabled`)
    .setDescription(
      `${E.user} **${member.user.username}** is now AFK.\n` +
        `**Reason:** ${reason}\n` +
        nickLine +
        `\n_Your AFK will be removed automatically when you send a message._`
    )
    .setFooter({ text: 'UECBOT • Use !afk <reason> to update your reason' });
}

function buildReturnEmbed(member, data) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`${E.rocket} Welcome Back, ${member.user.username}!`)
    .setDescription(`${E.okay} **I removed your AFK.**\n**Reason was:** ${data ? data.reason : 'unknown'}\n**AFK since:** ${data ? timeAgo(data.since) : 'unknown'}`);

  const mentions = (data && data.mentions) || [];
  if (mentions.length) {
    const shown = mentions.slice(-MAX_SHOWN);
    const lines = shown.map((m) => {
      const link = `https://discord.com/channels/${m.guildId}/${m.channelId}/${m.messageId}`;
      const text = m.content.length > 120 ? m.content.slice(0, 120) + '…' : m.content;
      return `**${m.author}** — [message](${link})\n> ${text}`;
    });
    const extra = mentions.length - shown.length;
    embed.addFields({
      name: `${E.message} While you were away (${mentions.length} mention${mentions.length > 1 ? 's' : ''})`,
      value: lines.join('\n\n') + (extra > 0 ? `\n\n_...and ${extra} more_` : ''),
    });
  } else {
    embed.addFields({
      name: `${E.message} While you were away`,
      value: 'No one mentioned you.',
    });
  }

  return embed;
}

function buildPingEmbed(user, data) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`${E.warning} AFK Alert`)
    .setDescription(
      `**${user.username}** is AFK and left a message:\n` +
        `> ${data.reason}\n\n` +
        `${E.clock} AFK since ${timeAgo(data.since)} • _They will see your message when they return._`
    );
}

module.exports = {
  get,
  setAfk,
  clearAfk,
  trackMention,
  buildSetEmbed,
  buildReturnEmbed,
  buildPingEmbed,
  NICK_PREFIX,
};
