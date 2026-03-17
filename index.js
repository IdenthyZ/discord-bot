const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;
// Canal donde se enviarán los logs de auditoría
const AUDIT_LOG_CHANNEL_ID = process.env.AUDIT_LOG_CHANNEL_ID || MOD_LOGS_CHANNEL_ID;


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
import https from 'https';
import axios from 'axios';
import ffmpegStatic from 'ffmpeg-static';
import Redis from 'ioredis';
import http from 'node:http';
import { execSync } from 'node:child_process';

// Servidor de Salud para Railway (Evita que el contenedor se apague)
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Online\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 [HealthCheck] Servidor activo en puerto ${PORT}`);
});

// Configuración de Redis: Railway inyecta REDIS_URL automáticamente
const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl) : null;

if (redis) {
  console.log('🔄 Intentando conectar con la base de datos Redis...');
  redis.on('connect', () => console.log('✅ DATABASE: Conectado a Redis exitosamente'));
  redis.on('error', (err) => console.error('❌ DATABASE Error:', err.message));
} else {
  console.log('⚠️ DATABASE: No se detectó REDIS_URL, usando almacenamiento local JSON');
}

// FFmpeg Config
let ffmpegBin = ffmpegStatic;

// Detectar ffmpeg del sistema en Linux (especialmente para Docker/Railway)
if (process.platform !== 'win32') {
  try {
    const systemFfmpeg = execSync('which ffmpeg').toString().trim();
    if (systemFfmpeg) {
      ffmpegBin = systemFfmpeg;
      console.log(`✅ FFmpeg detectado en el sistema: ${ffmpegBin}`);
    }
  } catch (e) {
    console.log('⚠️ FFmpeg no detectado en el sistema, usando ffmpeg-static');
  }
} else {
  const winPath = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
  if (fs.existsSync(winPath)) ffmpegBin = winPath;
}

process.env.FFMPEG_PATH = ffmpegBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;

// Manejo de errores global para evitar que el contenedor se apague sin avisar
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ [Unhandled Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ [Uncaught Exception]:', err);
});

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;
const SORTEOS_CHANNEL_ID = process.env.SORTEOS_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const TICKET_LOGS_CHANNEL_ID = process.env.TICKET_LOGS_CHANNEL_ID;
const TICKET_ADMIN_ROLE_ID = process.env.TICKET_ADMIN_ROLE_ID || '1442336261464658096';

const INVITES_CHANNEL_ID = process.env.INVITES_CHANNEL_ID || '1472089754332958851';
const ALLYS_CHANNEL_ID = process.env.ALLYS_CHANNEL_ID || '1472827620209987664';
const ALLYS_ADMIN_ROLE_ID = process.env.ALLYS_ADMIN_ROLE_ID || '1442336261464658096';
const MEMBER_COUNT_CATEGORY_NAME = process.env.MEMBER_COUNT_CATEGORY_NAME || '📈 • Contador';
const MEMBER_COUNT_CHANNEL_TEMPLATE = '🧑‍🤝‍🧑 Total: {count}';

if (!TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Faltan variables de entorno: DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID');
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
  behaviors: {
    noSubscriber: NoSubscriberBehavior.Play,
  },
});

const activeSorteos = new Map();
const inviteCounts = new Map();
const memberInviters = new Map();
const invitesCache = new Map();

// --- LÓGICA DE PERSISTENCIA REDIS ---
async function loadInvitesData() {
  try {
    let raw;
    if (redis) {
      raw = await redis.get('bot:invites');
    }
    if (!raw) {
      const p = path.join(process.cwd(), 'data', 'invites.json');
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf-8');
    }
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.counts) Object.entries(data.counts).forEach(([id, c]) => inviteCounts.set(id, Number(c)));
    if (data.members) Object.entries(data.members).forEach(([id, inv]) => memberInviters.set(id, inv));
    console.log('[Invites] Datos cargados correctamente');
  } catch (err) { console.error('[Invites] Load Error:', err.message); }
}

async function saveInvitesData() {
  try {
    const data = JSON.stringify({ 
      counts: Object.fromEntries(inviteCounts), 
      members: Object.fromEntries(memberInviters) 
    });
    if (redis) await redis.set('bot:invites', data);
    else {
      const p = path.join(process.cwd(), 'data', 'invites.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
  } catch (err) { console.error('[Invites] Save Error:', err.message); }
}

async function loadSorteosData() {
  try {
    let raw;
    if (redis) raw = await redis.get('bot:sorteos');
    if (!raw) {
      const p = path.join(process.cwd(), 'data', 'sorteos.json');
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf-8');
    }
    if (!raw) return;
    const data = JSON.parse(raw);
    Object.entries(data).forEach(([id, s]) => {
      s.participantes = new Set(s.participantes || []);
      activeSorteos.set(id, s);
    });
    console.log(`[Sorteos] ${activeSorteos.size} cargados`);
  } catch (err) { console.error('[Sorteos] Load Error:', err.message); }
}

async function saveSorteosData() {
  try {
    const obj = {};
    activeSorteos.forEach((s, id) => {
      obj[id] = { ...s, participantes: Array.from(s.participantes) };
    });
    const data = JSON.stringify(obj);
    if (redis) await redis.set('bot:sorteos', data);
    else {
      const p = path.join(process.cwd(), 'data', 'sorteos.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
  } catch (err) { console.error('[Sorteos] Save Error:', err.message); }
}

// --- FUNCIONES AUXILIARES ---
function formatMemberCountName(count) {
  return MEMBER_COUNT_CHANNEL_TEMPLATE.replace('{count}', String(count));
}

async function updateMemberCountChannel(guild) {
  try {
    const category = guild.channels.cache.find(c => c.name === MEMBER_COUNT_CATEGORY_NAME && c.type === ChannelType.GuildCategory)
      || await guild.channels.create({ name: MEMBER_COUNT_CATEGORY_NAME, type: ChannelType.GuildCategory });
    
    const prefix = MEMBER_COUNT_CHANNEL_TEMPLATE.split('{')[0];
    let channel = guild.channels.cache.find(c => c.parentId === category.id && c.name.startsWith(prefix));
    
    if (!channel) {
      channel = await guild.channels.create({
        name: formatMemberCountName(guild.memberCount),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: [{ id: guild.id, deny: [PermissionsBitField.Flags.Connect] }]
      });
    } else {
      await channel.setName(formatMemberCountName(guild.memberCount));
    }
  } catch (err) { console.error('[MemberCount] Error:', err.message); }
}

async function refreshInvitesCache() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const invites = await guild.invites.fetch();
  invitesCache.clear();
  invites.forEach(i => invitesCache.set(i.code, i.uses || 0));
}

// --- RADIO 24/7 ---
const STREAM_URL = 'https://stream.maxiradio.mx:1033/live';
async function startRadio() {
  try {
    const res = await axios.get(STREAM_URL, { responseType: 'stream', timeout: 15000 });
    const { stream, type } = await demuxProbe(res.data);
    player.play(createAudioResource(stream, { inputType: type }));
  } catch (err) { setTimeout(startRadio, 10000); }
}

player.on(AudioPlayerStatus.Idle, startRadio);
player.on('error', () => setTimeout(startRadio, 5000));

async function joinAndStay() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });
  connection.subscribe(player);
  return connection;
}

// --- EVENTOS PRINCIPALES ---
client.on(Events.ClientReady, async () => {
  console.log(`✅ [Bot] Intentando iniciar sesión como ${client.user.tag}...`);
  try {
    console.log('[Bot] Cargando datos de invitaciones...');
    await loadInvitesData();
    console.log('[Bot] Cargando datos de sorteos...');
    await loadSorteosData();
    
    console.log('[Bot] Uniéndose al canal de voz...');
    joinAndStay().catch(err => console.error('[Bot] Error al unirse a voz:', err.message));
    
    console.log('[Bot] Iniciando radio...');
    startRadio();
    
    console.log('[Bot] Reactivando sorteos antiguos...');
    activeSorteos.forEach((s, id) => {
      const remaining = s.endTime - Date.now();
      if (remaining > 0) setTimeout(() => finalizarSorteo(id), remaining);
      else finalizarSorteo(id);
    });
    
    console.log('[Bot] Refrescando cache de invitaciones...');
    refreshInvitesCache().catch(() => {});
    
    console.log(`✅ [Bot] ¡Todo listo! Online como ${client.user.tag}`);
  } catch (err) {
    console.error('❌ [Bot] Error crítico durante el inicio:', err);
  }
});

client.on('guildMemberAdd', async (m) => {
  // Conteo de invites
  const newInvites = await m.guild.invites.fetch();
  const used = newInvites.find(i => (i.uses || 0) > (invitesCache.get(i.code) || 0));
  refreshInvitesCache();

  if (used && used.inviter) {
    const count = (inviteCounts.get(used.inviter.id) || 0) + 1;
    inviteCounts.set(used.inviter.id, count);
    memberInviters.set(m.id, used.inviter.id);
    saveInvitesData();
  }

  // Bienvenida
  if (WELCOME_CHANNEL_ID) {
    const ch = await m.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
    if (ch) {
      const emb = new EmbedBuilder()
        .setTitle(`${m.user.username} ¡Bienvenido! 🎉`)
        .setDescription(`Tickets: <#${TICKET_CHANNEL_ID}>\nChat: <#${CHAT_CHANNEL_ID}>\nSorteos: <#${SORTEOS_CHANNEL_ID}>`)
        .setThumbnail(m.user.displayAvatarURL())
        .setColor('#ff9cbf')
        .setFooter({ text: `${m.guild.name} • ${new Date().toLocaleDateString()}` });
      ch.send({ embeds: [emb] });
    }
  }

  if (MEMBER_ROLE_ID) m.roles.add(MEMBER_ROLE_ID).catch(() => {});
  updateMemberCountChannel(m.guild);
});

client.on('guildMemberRemove', (m) => {
  const inv = memberInviters.get(m.id);
  if (inv) {
    inviteCounts.set(inv, Math.max(0, (inviteCounts.get(inv) || 0) - 1));
    memberInviters.delete(m.id);
    saveInvitesData();
  }
  updateMemberCountChannel(m.guild);
});

// --- COMANDOS Y MODALES ---
client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild) return;

  if (msg.content === '!setup-ticket' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const emb = new EmbedBuilder().setTitle('Tickets').setDescription('Usa el botón para abrir un ticket.').setColor('#ff9cbf');
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('Abrir Ticket').setStyle(ButtonStyle.Primary));
    msg.channel.send({ embeds: [emb], components: [btn] });
  }

  if (msg.content === '!sorteo' && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const emb = new EmbedBuilder().setTitle('Sorteos').setDescription('Usa el botón para crear un sorteo.').setColor('#00FF00');
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_sorteo_modal').setLabel('Crear Sorteo').setStyle(ButtonStyle.Success));
    msg.channel.send({ embeds: [emb], components: [btn] });
  }
});

client.on('interactionCreate', async (i) => {
  if (i.isButton()) {
    if (i.customId === 'create_ticket') {
      const modal = new ModalBuilder().setCustomId('ticket_modal').setTitle('Motivo del Ticket');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('¿Por qué abres el ticket?').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return i.showModal(modal);
    }
    if (i.customId === 'open_sorteo_modal') {
      const modal = new ModalBuilder().setCustomId('sorteo_modal').setTitle('Configurar Sorteo');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dur').setLabel('Duración (1m, 1h, 1d)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('win').setLabel('Ganadores').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prz').setLabel('Premio').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req').setLabel('Requisito Invitaciones (0-3)').setStyle(TextInputStyle.Short).setRequired(true))
      );
      return i.showModal(modal);
    }
    if (i.customId === 'participar_sorteo') {
      const s = activeSorteos.get(i.message.id);
      if (!s) return i.reply({ content: '❌ Sorteo no activo.', ephemeral: true });
      if (s.participantes.has(i.user.id)) {
        s.participantes.delete(i.user.id);
        i.reply({ content: 'Has salido del sorteo.', ephemeral: true });
      } else {
        const req = s.requisitoInvite || 0;
        if ((inviteCounts.get(i.user.id) || 0) < req) return i.reply({ content: `❌ Necesitas ${req} invitaciones.`, ephemeral: true });
        s.participantes.add(i.user.id);
        i.reply({ content: '¡Estás participando! 🎉', ephemeral: true });
      }
      saveSorteosData();
      const emb = EmbedBuilder.from(i.message.embeds[0]).setFields({ name: 'Participantes', value: `${s.participantes.size}`, inline: true });
      i.message.edit({ embeds: [emb] });
    }
  }

  if (i.isModalSubmit()) {
    if (i.customId === 'ticket_modal') {
      const ch = await i.guild.channels.create({
        name: `ticket-${i.user.username}`,
        parent: TICKET_CATEGORY_ID,
        permissionOverwrites: [
          { id: i.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: i.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
        ]
      });
      ch.send({ content: `Nuevo ticket de ${i.user}: ${i.fields.getTextInputValue('motivo')}` });
      i.reply({ content: `Ticket creado: ${ch}`, ephemeral: true });
    }
    if (i.customId === 'sorteo_modal') {
      const dur = i.fields.getTextInputValue('dur'), win = parseInt(i.fields.getTextInputValue('win')), prz = i.fields.getTextInputValue('prz'), req = parseInt(i.fields.getTextInputValue('req'));
      const match = dur.match(/^(\d+)([mhd])$/);
      let ms = parseInt(match[1]) * 60000;
      if (match[2] === 'h') ms *= 60; if (match[2] === 'd') ms *= 24;
      const endTime = Date.now() + ms;
      
      const emb = new EmbedBuilder().setTitle('🎉 SORTEO').setDescription(`**Premio:** ${prz}\n**Termina:** <t:${Math.floor(endTime/1000)}:R>`).addFields({ name: 'Participantes', value: '0', inline: true }).setColor('#00FF00');
      const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('participar_sorteo').setLabel('Participar').setStyle(ButtonStyle.Success).setEmoji('🎉'));
      
      const ch = SORTEOS_CHANNEL_ID ? await i.guild.channels.fetch(SORTEOS_CHANNEL_ID) : i.channel;
      const msg = await ch.send({ content: '@everyone', embeds: [emb], components: [btn] });
      
      activeSorteos.set(msg.id, { premio: prz, ganadores: win, endTime, channelId: ch.id, requisitoInvite: req, participantes: new Set() });
      saveSorteosData();
      setTimeout(() => finalizarSorteo(msg.id), ms);
      i.reply({ content: 'Sorteo creado.', ephemeral: true });
    }
  }
});

async function finalizarSorteo(id) {
  const s = activeSorteos.get(id); if (!s) return;
  try {
    const ch = await client.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(id);
    const winners = Array.from(s.participantes).sort(() => 0.5 - Math.random()).slice(0, s.ganadores);
    const emb = EmbedBuilder.from(msg.embeds[0]).setTitle('🎉 SORTEO FINALIZADO').setDescription(`**Premio:** ${s.premio}\n**Ganadores:** ${winners.map(w => `<@${w}>`).join(', ') || 'Nadie'}`);
    await msg.edit({ embeds: [emb], components: [] });
    if (winners.length) ch.send(`🎊 ¡Felicidades ${winners.map(w => `<@${w}>`).join(', ')}! Ganaste **${s.premio}**.`);
  } catch {}
  activeSorteos.delete(id); saveSorteosData();
}

client.login(TOKEN);
