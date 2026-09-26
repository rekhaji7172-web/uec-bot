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
const GUILD_ID = process.env.GUILD_ID || '';

if (!TOKEN) {
  console.error('[ERROR] DISCORD_TOKEN not found. Create a .env file (see .env.example)');
  process.exit(1);
}

const E = {
  document: '<:document:1553319071024550019>',
  view: '<:view:1553319992542629888>',
  verified: '<:verified:1553319986548711474>',
  click: '<:click:1553318995166371870>',
  rightarrow: '<:rightarrow:1553319551855231009>',
  search: '<:search:1553319601335439410>',
  warning: '<:warning:1553320016005431327>',
  menu: '<:menu:1553319217342976070>',
  handshake: '<:handshake:1553319161743020135>',
  rocket: '<:rocket:1553319575318167563>',
  clock: '<:clock:1553319001713811516>',
  okay: '<:okay:1553319280312066068>',
};

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
    if (message.author.bot) return;
    if (!CHANNEL_IDS.has(message.channelId)) return;
    const query = message.content.trim();
    if (!query) return;

    const payload = resolve(query);
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
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: COMMANDS });
      console.log(`Slash commands registered (guild ${GUILD_ID})`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: COMMANDS });
      console.log('Slash commands registered globally (may take up to 1 hour)');
    }
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
