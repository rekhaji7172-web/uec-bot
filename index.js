const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  ApplicationCommandOptionType,
} = require('discord.js');
const { ALL_PACKS, searchPacks } = require('./scenepacks');
const AFK = require('./afk');

function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i === -1) continue;
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_IDS = new Set(
  (process.env.CHANNEL_ID || '1513842246586208266')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

if (!TOKEN) {
  console.error('[ERROR] DISCORD_TOKEN not found. Create a .env file (see .env.example)');
  process.exit(1);
}

const E = require('./emojis');

const COLOR = 0x5865f2;
const CREDITS = 'https://discord.gg/vnjyfqN688';
const CREDITS_LINE = `${E.handshake} **Credits:** [Discord Server](${CREDITS})`;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function linkRows(pack) {
  const rows = [];
  let row = new ActionRowBuilder();
  pack.links.forEach((url, i) => {
    if (i > 0 && i % 5 === 0) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setLabel(`Download Link ${i + 1}`)
        .setEmoji(E.rightarrow)
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );
  });
  rows.push(row);
  return rows.slice(0, 5);
}

function packEmbed(pack) {
  const links = pack.links
    .map((url, i) => `[\`Link ${i + 1}\` ↗](${url})`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${E.document} ${pack.name} — Scenepack`)
    .setDescription(
      `${E.verified} **${pack.name}** scenepack found! Grab your download below 👇\n\n${CREDITS_LINE}`
    )
    .addFields(
      { name: `${E.view} Aspect Ratio`, value: `\`${pack.ratio}\``, inline: true },
      {
        name: `${E.click} Download Links (${pack.links.length})`,
        value: links,
        inline: false,
      }
    )
    .setFooter({ text: 'UECBOT • Type any creator name to search more packs' });
}

function packListLines(packs) {
  return packs
    .slice(0, 20)
    .map((p) => `▸ **${p.name}** — \`${p.ratio}\``)
    .join('\n');
}

function listEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`${E.menu} Available Scenepacks (${ALL_PACKS.length})`)
    .setDescription(packListLines(ALL_PACKS) + `\n\n${CREDITS_LINE}`)
    .setFooter({ text: 'Just type a name (e.g. Boosfer) to get the link' });
}

function manyEmbed(packs, query) {
  const extra = packs.length - 20;
  const desc =
    `${E.search} **${packs.length}** scenepacks matched **"${query}"**:\n\n` +
    packListLines(packs) +
    (extra > 0 ? `\n▸ _...and ${extra} more_` : '') +
    `\n\nType the **full name** for the exact link.\n\n${CREDITS_LINE}`;
  return new EmbedBuilder().setColor(0xfee75c).setTitle(`${E.search} Multiple Results Found`).setDescription(desc);
}

function noneEmbed(query) {
  const preview = ALL_PACKS.slice(0, 10)
    .map((p) => `▸ ${p.name}`)
    .join('\n');
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle(`${E.warning} Scenepack Not Found`)
    .setDescription(
      `No scenepack found for **"${query}"**.\n\n**Available:**\n${preview}\n▸ _...and ${
        ALL_PACKS.length - 10
      } more_ (type \`list\` for the full list)\n\n${CREDITS_LINE}`
    )
    .setFooter({ text: 'Double-check the spelling' });
}

function resolve(query) {
  const result = searchPacks(query);

  if (result.type === 'one') {
    return { embeds: [packEmbed(result.packs[0])], components: linkRows(result.packs[0]), ephemeral: false };
  }
  if (result.type === 'many') {
    return { embeds: [manyEmbed(result.packs, query)], components: [], ephemeral: true };
  }
  if (result.type === 'list') {
    return { embeds: [listEmbed()], components: [], ephemeral: true };
  }
  if (result.wordCount >= 5) return null;
  return { embeds: [noneEmbed(query)], components: [], ephemeral: true };
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    const content = message.content.trim();

    const afkCmd = content.match(/^!afk(?:\s+([\s\S]+))?$/i);
    if (afkCmd) {
      const reason = (afkCmd[1] || 'No reason provided').trim().slice(0, 300);
      await AFK.setAfk(message.member, reason);
      await message.channel.send({
        embeds: [AFK.buildSetEmbed(message.member, reason)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (AFK.get(message.guild.id, message.author.id)) {
      const data = await AFK.clearAfk(message.member);
      await message.channel.send({
        embeds: [AFK.buildReturnEmbed(message.member, data)],
        allowedMentions: { users: [message.author.id] },
      });
    }

    const mentioned = [...message.mentions.users.values()].filter(
      (u) => !u.bot && u.id !== message.author.id
    );
    const afkMentioned = mentioned.filter((u) => AFK.get(message.guild.id, u.id));
    if (afkMentioned.length) {
      for (const u of afkMentioned) {
        AFK.trackMention(message.guild.id, u.id, {
          author: message.author.username,
          content,
          guildId: message.guild.id,
          channelId: message.channel.id,
          messageId: message.id,
          time: Date.now(),
        });
      }
      const embeds = afkMentioned.map((u) =>
        AFK.buildPingEmbed(u, AFK.get(message.guild.id, u.id))
      );
      await message.channel.send({ embeds, allowedMentions: { parse: [] } });
    }

    if (!content) return;
    if (!CHANNEL_IDS.has(message.channelId)) return;

    const payload = resolve(content);
    if (!payload) return;

    await message.channel.send({
      ...payload,
      allowedMentions: { repliedUser: false, parse: [] },
    });
  } catch (err) {
    console.error('[messageCreate]', err);
  }
});

const COMMANDS = [
  {
    name: 'scenepack',
    description: 'Find a scenepack link (e.g. Lettuce, Boosfer, Jaden...)',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'name',
        description: 'Creator or pack name',
        required: true,
        autocomplete: true,
      },
    ],
  },
];

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = (interaction.options.getFocused() || '').toLowerCase();
      const choices = ALL_PACKS.filter((p) => p.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map((p) => ({ name: `${p.name} (${p.ratio})`, value: p.name }));
      await interaction.respond(choices);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'scenepack') {
      const query = interaction.options.getString('name', true);
      const payload = resolve(query) || { embeds: [noneEmbed(query)], components: [], ephemeral: true };
      await interaction.reply({ ...payload, ephemeral: Boolean(payload.ephemeral) });
    }
  } catch (err) {
    console.error('[interactionCreate]', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction
        .reply({ content: 'Something went wrong, please try again.', ephemeral: true })
        .catch(() => {});
    }
  }
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Scenepack channels: ${[...CHANNEL_IDS].join(', ')}`);
  try {
    const rest = new REST().setToken(TOKEN);
    const guilds = await rest.get(Routes.userGuilds());
    let ok = 0;
    for (const g of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, g.id), { body: COMMANDS });
        ok++;
      } catch (err) {
        console.error(`[commands] ${g.name}: ${err.message}`);
      }
    }
    console.log(`Slash commands registered in ${ok}/${guilds.length} servers`);
  } catch (err) {
    if (err.code === 50001) {
      console.error('[commands] Missing Access - bot is not in that server. Invite it first (see invite URL).');
    } else {
      console.error('[commands]', err);
    }
  }
});

client.login(TOKEN).catch((err) => {
  console.error('[ERROR] Login failed:', err.message);
  process.exit(1);
});
