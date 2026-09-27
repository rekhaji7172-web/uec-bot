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
const AI = require('./ai');
const STATS = require('./stats');

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

const FC_COOLDOWN = new Map();

const FACTCHECK_PROMPT = [
  'You are a fact-check assistant. The user gives you a claim. Reply in plain text (no markdown headers) with:',
  '1. First line: a verdict — one of: TRUE / FALSE / MOSTLY FALSE / PARTLY TRUE / UNVERIFIABLE (pick the closest, keep it short).',
  '2. Then 2-4 short bullet points (starting with "- ") giving the key evidence or reasoning.',
  '3. Last line: "Bottom line: " followed by one short sentence.',
  'Be accurate and neutral. If the claim is an opinion or not checkable, say UNVERIFIABLE and explain briefly. Keep the whole reply under 700 characters.',
].join('\n');
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

function startRow(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ai_start:${userId}`)
      .setLabel('Start Chat')
      .setEmoji(E.click)
      .setStyle(ButtonStyle.Success)
  );
}

function stripMentions(text) {
  return text.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();
}

async function sendChannelStats(channel, arg) {
  await channel.sendTyping().catch(() => {});
  try {
    const data = await STATS.getChannelStats(arg);
    await channel.send({ ...STATS.buildChannelEmbed(data), allowedMentions: { parse: [] } });
  } catch (err) {
    await channel.send({ embeds: [STATS.buildErrorEmbed(err.message)] }).catch(() => {});
  }
}

async function answerQuestion(channel, session, question) {
  AI.pushHistory(session, 'user', question);
  try {
    await channel.sendTyping();
    const reply = await AI.askAI(session.history, question);
    AI.pushHistory(session, 'assistant', reply);
    await channel.send({ content: reply, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error('[ai]', (err && err.message) || err);
    if (session.history.length && session.history[session.history.length - 1].role === 'user') {
      session.history.pop();
    }
    await channel
      .send({ embeds: [AI.buildErrorEmbed(err && err.message)], allowedMentions: { parse: [] } })
      .catch(() => {});
  }
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;
    const content = message.content.trim();

    const afkCmd = content.match(/^!afk(?:\s+([\s\S]+))?$/i);
    if (afkCmd) {
      const reason = (afkCmd[1] || 'No reason provided').trim().slice(0, 300);
      const data = await AFK.setAfk(message.member, reason);
      await message.channel.send({
        embeds: [AFK.buildSetEmbed(message.member, reason, data)],
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

    const askCmd = content.match(/^!ask(?:\s+([\s\S]+))?$/i);
    if (askCmd) {
      const question = (askCmd[1] || '').trim();
      const startMsg = await message.channel.send({
        embeds: [AI.buildStartEmbed(question)],
        components: [startRow(message.author.id)],
        allowedMentions: { parse: [] },
      });
      if (question) AI.setPending(startMsg.id, question);
      return;
    }

    if (/^!end$/i.test(content)) {
      if (AI.endSession(message.channelId, message.author.id)) {
        await message.channel.send({ embeds: [AI.buildStopEmbed()], allowedMentions: { parse: [] } });
      }
      return;
    }

    if (/^!(?:help|h|cmds|commands|menu)$/i.test(content)) {
      await message.channel.send({ embeds: [STATS.buildHelpEmbed()] });
      return;
    }

    const fcCmd = content.match(/^!(?:factcheck|fact\s?check|fc)(?:\s+([\s\S]+))?$/i);
    if (fcCmd) {
      const claim = (fcCmd[1] || '').trim().slice(0, 500);
      if (!claim) {
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`${E.warning} Fact Check — missing claim`)
              .setDescription('Usage: `!fc <claim>`\nExample: `!fc the earth is flat`')
              .setFooter({ text: 'UECBOT' }),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }
      const last = FC_COOLDOWN.get(message.author.id) || 0;
      if (Date.now() - last < 5000) {
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xfee75c)
              .setTitle(`${E.clock} Hold on...`)
              .setDescription('Wait a few seconds before the next fact check.')
              .setFooter({ text: 'UECBOT' }),
          ],
          allowedMentions: { parse: [] },
        });
        return;
      }
      FC_COOLDOWN.set(message.author.id, Date.now());
      await message.channel.sendTyping().catch(() => {});
      try {
        const reply = await AI.askAI([], claim, FACTCHECK_PROMPT);
        await message.channel.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0x5865f2)
              .setTitle(`${E.verified} Fact Check`)
              .setDescription(`**Claim:** ${claim.slice(0, 300)}\n\n${reply}`.slice(0, 4096))
              .setFooter({ text: 'UECBOT • AI-powered fact check' })
              .setTimestamp(),
          ],
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error('[fc]', (err && err.message) || err);
        await message.channel
          .send({ embeds: [AI.buildErrorEmbed(err && err.message)], allowedMentions: { parse: [] } })
          .catch(() => {});
      }
      return;
    }

    const statsCmd = content.match(/^!stats(?:\s+([\s\S]+))?$/i);
    if (statsCmd) {
      const arg = (statsCmd[1] || '').trim();
      if (!arg) {
        await message.channel.send({ embeds: [STATS.buildServerEmbed(message.guild, client)] });
        return;
      }
      await sendChannelStats(message.channel, arg);
      return;
    }

    const session = AI.getSession(message.channelId, message.author.id);
    const mentionsBot = Boolean(client.user && message.mentions.has(client.user));

    if (session && !content.startsWith('!')) {
      if (!mentionsBot) return;
      if (AI.onCooldown(session)) return;
      const question = stripMentions(content) || content;
      await answerQuestion(message.channel, session, question);
      return;
    }

    if (mentionsBot) {
      const question = stripMentions(content);
      const startMsg = await message.channel.send({
        embeds: [AI.buildStartEmbed(question)],
        components: [startRow(message.author.id)],
        allowedMentions: { parse: [] },
      });
      if (question) AI.setPending(startMsg.id, question);
      return;
    }

    if (!CHANNEL_IDS.has(message.channelId)) return;
    if (/https?:\/\//i.test(content)) return;

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
  {
    name: 'ask',
    description: 'Chat with the Unstable SMP AI (click Start Chat to begin)',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'question',
        description: 'Optional first question for the AI',
        required: false,
      },
    ],
  },
  {
    name: 'stats',
    description: 'Server stats, or full analysis of a YouTube channel link',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'url',
        description: 'YouTube channel link or @handle (empty = server stats)',
        required: false,
      },
    ],
  },
  {
    name: 'help',
    description: 'List all UECBOT commands',
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
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'ask') {
      const question = (interaction.options.getString('question') || '').trim();
      const startMsg = await interaction.reply({
        embeds: [AI.buildStartEmbed(question)],
        components: [startRow(interaction.user.id)],
        fetchReply: true,
      });
      if (question) AI.setPending(startMsg.id, question);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'stats') {
      const url = (interaction.options.getString('url') || '').trim();
      if (!url) {
        await interaction.reply({ embeds: [STATS.buildServerEmbed(interaction.guild, client)] });
        return;
      }
      await interaction.deferReply();
      try {
        const data = await STATS.getChannelStats(url);
        await interaction.editReply(STATS.buildChannelEmbed(data));
      } catch (err) {
        await interaction.editReply({ embeds: [STATS.buildErrorEmbed(err.message)] });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
      await interaction.reply({ embeds: [STATS.buildHelpEmbed()] });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ai_start:')) {
      const owner = interaction.customId.split(':')[1];
      if (interaction.user.id !== owner) {
        await interaction.reply({
          content: 'This button is not for you — use `/ask` or `!ask` to start your own chat.',
          ephemeral: true,
        });
        return;
      }

      let session = AI.getSession(interaction.channelId, interaction.user.id);
      const already = Boolean(session);
      if (!session) session = AI.startSession(interaction.channelId, interaction.user.id);

      const question = already ? null : AI.takePending(interaction.message.id);
      await interaction.update({ embeds: [AI.buildChatStartedEmbed()], components: [] });

      if (question) {
        await answerQuestion(interaction.channel, session, question);
      }
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
  if (!process.env.OPENROUTER_API_KEY) {
    console.warn('[warn] OPENROUTER_API_KEY not set - /ask AI will not work until you add it.');
  }
  if (process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_API_KEY.trim()) {
    console.log('YouTube Data API: ON (accurate !stats)');
  } else {
    console.log('YouTube Data API: not set - !stats using scraping fallback');
  }
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
