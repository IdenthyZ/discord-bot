import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  Events
} from 'discord.js';
import {
  entersState,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  demuxProbe,
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import ffmpegStatic from 'ffmpeg-static';
import Redis from 'ioredis';
import http from 'node:http';
import { execSync } from 'node:child_process';

// 📡 Servidor de Salud (Iniciado de inmediato para Railway)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`📡 [HealthCheck] Servidor activo en puerto ${PORT}`);
});

// 🗄 Configuración de Redis con soporte TLS para Railway
const redisUrl = process.env.REDIS_URL;
let redis = null;
if (redisUrl) {
  const redisOptions = redisUrl.startsWith('rediss://') 
    ? { redisOptions: { tls: { rejectUnauthorized: false } } }
    : {};
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 5,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    ...redisOptions
  });
  
  redis.on('connect', () => console.log('✅ [Redis] Conectado exitosamente'));
  redis.on('error', (err) => console.error('❌ [Redis] Error:', err.message));
}

// 🛠 Configuración FFmpeg
let ffmpegBin = ffmpegStatic;
if (process.platform !== 'win32') {
  try {
    const systemFfmpeg = execSync('which ffmpeg').toString().trim();
    if (systemFfmpeg) ffmpegBin = systemFfmpeg;
  } catch (e) {}
}
process.env.FFMPEG_PATH = ffmpegBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;

// 🤖 Variables de Entorno
const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;
const SORTEOS_CHANNEL_ID = process.env.SORTEOS_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const TICKET_ADMIN_ROLE_ID = process.env.TICKET_ADMIN_ROLE_ID || '1442336261464658096';

if (!TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('❌ Faltan variables críticas: DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});

const activeSorteos = new Map();
const inviteCounts = new Map();
const memberInviters = new Map();
const invitesCache = new Map();

// --- LÓGICA DE PERSISTENCIA ---
async function loadData() {
  try {
    let rawInv;
    if (redis) rawInv = await redis.get('bot:invites');
    if (!rawInv && fs.existsSync('data/invites.json')) rawInv = fs.readFileSync('data/invites.json', 'utf-8');
    if (rawInv) {
      const data = JSON.parse(rawInv);
      if (data.counts) Object.entries(data.counts).forEach(([id, c]) => inviteCounts.set(id, Number(c)));
      if (data.members) Object.entries(data.members).forEach(([id, inv]) => memberInviters.set(id, inv));
    }

    let rawSor;
    if (redis) rawSor = await redis.get('bot:sorteos');
    if (!rawSor && fs.existsSync('data/sorteos.json')) rawSor = fs.readFileSync('data/sorteos.json', 'utf-8');
    if (rawSor) {
      const data = JSON.parse(rawSor);
      Object.entries(data).forEach(([id, s]) => {
        s.participantes = new Set(s.participantes || []);
        activeSorteos.set(id, s);
      });
    }
    console.log('✅ [Datos] Cargados correctamente');
  } catch (err) { console.error('❌ [Datos] Error:', err.message); }
}

async function saveData() {
  try {
    const invData = JSON.stringify({ counts: Object.fromEntries(inviteCounts), members: Object.fromEntries(memberInviters) });
    const sorData = JSON.stringify(Object.fromEntries(Array.from(activeSorteos.entries()).map(([id, s]) => [id, { ...s, participantes: Array.from(s.participantes) }])));
    
    if (redis) {
      await redis.set('bot:invites', invData);
      await redis.set('bot:sorteos', sorData);
    } else {
      if (!fs.existsSync('data')) fs.mkdirSync('data');
      fs.writeFileSync('data/invites.json', invData);
      fs.writeFileSync('data/sorteos.json', sorData);
    }
  } catch (err) { console.error('❌ [Datos] Error al guardar:', err.message); }
}

// --- RADIO ---
const STREAM_URL = 'https://stream.maxiradio.mx:1033/live';
async function startRadio() {
  try {
    const res = await axios.get(STREAM_URL, { responseType: 'stream', timeout: 15000 });
    const { stream, type } = await demuxProbe(res.data);
    player.play(createAudioResource(stream, { inputType: type }));
    console.log('📻 [Radio] Reproduciendo');
  } catch (err) {
    console.error('❌ [Radio] Error:', err.message);
    setTimeout(startRadio, 10000);
  }
}

player.on(AudioPlayerStatus.Idle, startRadio);
player.on('error', (err) => {
  console.error('❌ [Radio] Error:', err.message);
  setTimeout(startRadio, 5000);
});

async function joinAndStay() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const connection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true
    });
    connection.subscribe(player);
    console.log('✅ [Voz] Conectado');
  } catch (err) {
    console.error('❌ [Voz] Error:', err.message);
    setTimeout(joinAndStay, 20000);
  }
}

// --- EVENTOS PRINCIPALES ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 [Bot] Online como ${client.user.tag}`);
  await loadData();
  joinAndStay();
  startRadio();

  activeSorteos.forEach((s, id) => {
    const remaining = s.endTime - Date.now();
    setTimeout(() => finalizarSorteo(id), Math.max(remaining, 1000));
  });

  const g = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (g) {
    const invs = await g.invites.fetch().catch(() => []);
    invs.forEach(i => invitesCache.set(i.code, i.uses || 0));
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  if (msg.content === '!setup-ticket') {
    const emb = new EmbedBuilder().setTitle('Sistema de Tickets').setDescription('Pulsa el botón de abajo para abrir un ticket de soporte.').setColor('#ff9cbf');
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('Abrir Ticket').setStyle(ButtonStyle.Primary).setEmoji('📩'));
    msg.channel.send({ embeds: [emb], components: [btn] });
  }

  if (msg.content === '!sorteo') {
    const emb = new EmbedBuilder().setTitle('Gestión de Sorteos').setDescription('Pulsa el botón para configurar un nuevo sorteo.').setColor('#00FF00');
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_sorteo_modal').setLabel('Crear Sorteo').setStyle(ButtonStyle.Success).setEmoji('🎉'));
    msg.channel.send({ embeds: [emb], components: [btn] });
  }
});

client.on('interactionCreate', async (i) => {
  if (i.isButton()) {
    if (i.customId === 'create_ticket') {
      const modal = new ModalBuilder().setCustomId('ticket_modal').setTitle('Motivo del Soporte');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Explica brevemente tu problema').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return i.showModal(modal);
    }
    if (i.customId === 'open_sorteo_modal') {
      const modal = new ModalBuilder().setCustomId('sorteo_modal').setTitle('Configurar Nuevo Sorteo');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dur').setLabel('Duración (ej: 10m, 1h, 1d)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('win').setLabel('Número de Ganadores').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prz').setLabel('Premio').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req').setLabel('Invitaciones Necesarias (0-3)').setStyle(TextInputStyle.Short).setRequired(true))
      );
      return i.showModal(modal);
    }
    if (i.customId === 'participar_sorteo') {
      const s = activeSorteos.get(i.message.id);
      if (!s) return i.reply({ content: '❌ Este sorteo ya no está activo.', ephemeral: true });
      if (s.participantes.has(i.user.id)) {
        s.participantes.delete(i.user.id);
        i.reply({ content: 'Has cancelado tu participación.', ephemeral: true });
      } else {
        const req = s.requisitoInvite || 0;
        if ((inviteCounts.get(i.user.id) || 0) < req) return i.reply({ content: `❌ Necesitas al menos ${req} invitaciones para participar.`, ephemeral: true });
        s.participantes.add(i.user.id);
        i.reply({ content: '¡Ya estás participando en el sorteo! 🎉', ephemeral: true });
      }
      saveData();
      const emb = EmbedBuilder.from(i.message.embeds[0]).setFields({ name: 'Participantes', value: `${s.participantes.size}`, inline: true });
      i.message.edit({ embeds: [emb] });
    }
  }

  if (i.isModalSubmit()) {
    if (i.customId === 'ticket_modal') {
      await i.deferReply({ ephemeral: true });
      try {
        const ch = await i.guild.channels.create({
          name: `ticket-${i.user.username}`,
          parent: TICKET_CATEGORY_ID,
          permissionOverwrites: [
            { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            { id: TICKET_ADMIN_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
          ]
        });
        const emb = new EmbedBuilder().setTitle('Ticket de Soporte').setDescription(`**Usuario:** ${i.user}\n**Motivo:** ${i.fields.getTextInputValue('motivo')}`).setColor('#ff9cbf').setTimestamp();
        ch.send({ content: `${i.user} | <@&${TICKET_ADMIN_ROLE_ID}>`, embeds: [emb] });
        i.editReply({ content: `Ticket creado exitosamente: ${ch}` });
      } catch (err) {
        i.editReply({ content: '❌ Error al crear el ticket. Verifica los permisos del bot.' });
      }
    }
    if (i.customId === 'sorteo_modal') {
      const dur = i.fields.getTextInputValue('dur'), win = parseInt(i.fields.getTextInputValue('win')), prz = i.fields.getTextInputValue('prz'), req = parseInt(i.fields.getTextInputValue('req'));
      const match = dur.match(/^(\d+)([mhd])$/);
      if (!match) return i.reply({ content: 'Formato de tiempo inválido (ej: 10m, 1h, 1d)', ephemeral: true });
      
      let ms = parseInt(match[1]) * 60000;
      if (match[2] === 'h') ms *= 60; if (match[2] === 'd') ms *= 24;
      const endTime = Date.now() + ms;
      
      const emb = new EmbedBuilder().setTitle('🎉 ¡NUEVO SORTEO!').setDescription(`**Premio:** ${prz}\n**Ganadores:** ${win}\n**Requisito:** ${req} invitaciones\n**Termina:** <t:${Math.floor(endTime/1000)}:R>`).addFields({ name: 'Participantes', value: '0', inline: true }).setColor('#00FF00').setTimestamp();
      const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('participar_sorteo').setLabel('Participar').setStyle(ButtonStyle.Success).setEmoji('🎉'));
      
      const ch = SORTEOS_CHANNEL_ID ? await i.guild.channels.fetch(SORTEOS_CHANNEL_ID) : i.channel;
      const msg = await ch.send({ content: '@everyone', embeds: [emb], components: [btn] });
      
      activeSorteos.set(msg.id, { premio: prz, ganadores: win, endTime, channelId: ch.id, requisitoInvite: req, participantes: new Set() });
      saveData();
      setTimeout(() => finalizarSorteo(msg.id), ms);
      i.reply({ content: 'Sorteo publicado correctamente.', ephemeral: true });
    }
  }
});

async function finalizarSorteo(id) {
  const s = activeSorteos.get(id); if (!s) return;
  try {
    const ch = await client.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(id);
    const winners = Array.from(s.participantes).sort(() => 0.5 - Math.random()).slice(0, s.ganadores);
    const emb = EmbedBuilder.from(msg.embeds[0]).setTitle('🎉 SORTEO FINALIZADO').setDescription(`**Premio:** ${s.premio}\n**Ganadores:** ${winners.map(w => `<@${w}>`).join(', ') || 'Nadie'}`).setColor('#FF0000');
    await msg.edit({ embeds: [emb], components: [] });
    if (winners.length) ch.send(`🎊 ¡Felicidades ${winners.map(w => `<@${w}>`).join(', ')}! Has ganado **${s.premio}**.`);
  } catch {}
  activeSorteos.delete(id); saveData();
}

client.on('guildMemberAdd', async (m) => {
  const invs = await m.guild.invites.fetch().catch(() => []);
  const used = invs.find(i => (i.uses || 0) > (invitesCache.get(i.code) || 0));
  invs.forEach(i => invitesCache.set(i.code, i.uses || 0));

  if (used && used.inviter) {
    inviteCounts.set(used.inviter.id, (inviteCounts.get(used.inviter.id) || 0) + 1);
    memberInviters.set(m.id, used.inviter.id);
    saveData();
  }

  if (WELCOME_CHANNEL_ID) {
    const ch = await m.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (ch) {
      const emb = new EmbedBuilder().setTitle(`¡Bienvenido/a ${m.user.username}!`).setDescription(`Disfruta de tu estancia en **${m.guild.name}**`).setColor('#ff9cbf').setThumbnail(m.user.displayAvatarURL());
      ch.send({ embeds: [emb] });
    }
  }
  if (MEMBER_ROLE_ID) m.roles.add(MEMBER_ROLE_ID).catch(() => {});
});

process.on('unhandledRejection', (r) => console.error('🔴 Rejection:', r));
process.on('uncaughtException', (e) => console.error('🔴 Exception:', e));

client.login(TOKEN);
