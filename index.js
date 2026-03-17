const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;
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

// 📡 Servidor de Salud (Prioridad Máxima para Railway)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`📡 [HealthCheck] Servidor activo en puerto ${PORT}`);
});

// 🛠 Configuración FFmpeg
let ffmpegBin = ffmpegStatic;
if (process.platform !== 'win32') {
  try {
    const systemFfmpeg = execSync('which ffmpeg').toString().trim();
    if (systemFfmpeg) {
      ffmpegBin = systemFfmpeg;
      const version = execSync(`${ffmpegBin} -version`).toString().split('\n')[0];
      console.log(`✅ [FFmpeg] Sistema detectado: ${version}`);
    }
  } catch (e) {
    console.log('⚠️ [FFmpeg] Usando binario estático (no se detectó en el sistema)');
  }
} else {
  const winPath = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
  if (fs.existsSync(winPath)) ffmpegBin = winPath;
}
process.env.FFMPEG_PATH = ffmpegBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;

// 🗄 Redis
const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000)
}) : null;

if (redis) {
  redis.on('connect', () => console.log('✅ [Redis] Conectado exitosamente'));
  redis.on('error', (err) => console.error('❌ [Redis] Error:', err.message));
}

// 🤖 Cliente Discord
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
const MEMBER_COUNT_CATEGORY_NAME = process.env.MEMBER_COUNT_CATEGORY_NAME || '📈 • Contador';
const MEMBER_COUNT_CHANNEL_TEMPLATE = '🧑‍🤝‍🧑 Total: {count}';

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
async function loadInvitesData() {
  try {
    let raw;
    if (redis) raw = await redis.get('bot:invites');
    if (!raw) {
      const p = path.join(process.cwd(), 'data', 'invites.json');
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf-8');
    }
    if (raw) {
      const data = JSON.parse(raw);
      if (data.counts) Object.entries(data.counts).forEach(([id, c]) => inviteCounts.set(id, Number(c)));
      if (data.members) Object.entries(data.members).forEach(([id, inv]) => memberInviters.set(id, inv));
      console.log('✅ [Invites] Datos cargados');
    }
  } catch (err) { console.error('❌ [Invites] Error al cargar:', err.message); }
}

async function saveInvitesData() {
  try {
    const data = JSON.stringify({ counts: Object.fromEntries(inviteCounts), members: Object.fromEntries(memberInviters) });
    if (redis) await redis.set('bot:invites', data);
    else {
      const p = path.join(process.cwd(), 'data', 'invites.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
  } catch (err) { console.error('❌ [Invites] Error al guardar:', err.message); }
}

async function loadSorteosData() {
  try {
    let raw;
    if (redis) raw = await redis.get('bot:sorteos');
    if (!raw) {
      const p = path.join(process.cwd(), 'data', 'sorteos.json');
      if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf-8');
    }
    if (raw) {
      const data = JSON.parse(raw);
      Object.entries(data).forEach(([id, s]) => {
        s.participantes = new Set(s.participantes || []);
        activeSorteos.set(id, s);
      });
      console.log(`✅ [Sorteos] ${activeSorteos.size} cargados`);
    }
  } catch (err) { console.error('❌ [Sorteos] Error al cargar:', err.message); }
}

async function saveSorteosData() {
  try {
    const obj = {};
    activeSorteos.forEach((s, id) => { obj[id] = { ...s, participantes: Array.from(s.participantes) }; });
    const data = JSON.stringify(obj);
    if (redis) await redis.set('bot:sorteos', data);
    else {
      const p = path.join(process.cwd(), 'data', 'sorteos.json');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
    }
  } catch (err) { console.error('❌ [Sorteos] Error al guardar:', err.message); }
}

// --- RADIO ---
const STREAM_URL = 'https://stream.maxiradio.mx:1033/live';
let isConnecting = false;

async function startRadio() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    console.log('📻 [Radio] Intentando conectar al stream...');
    const res = await axios.get(STREAM_URL, { responseType: 'stream', timeout: 15000 });
    const { stream, type } = await demuxProbe(res.data);
    player.play(createAudioResource(stream, { inputType: type }));
    console.log('✅ [Radio] Reproduciendo');
  } catch (err) {
    console.error('❌ [Radio] Error:', err.message);
    setTimeout(startRadio, 15000);
  } finally { isConnecting = false; }
}

player.on(AudioPlayerStatus.Idle, () => {
  console.log('📻 [Radio] Idle - Reiniciando...');
  startRadio();
});

player.on('error', (err) => {
  console.error('❌ [Radio] Player Error:', err.message);
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
    
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (e) {
        console.log('🔇 [Voz] Reconectando...');
        connection.destroy();
        joinAndStay();
      }
    });

    connection.subscribe(player);
    console.log('✅ [Voz] Conectado al canal');
  } catch (err) {
    console.error('❌ [Voz] Error:', err.message);
    setTimeout(joinAndStay, 20000);
  }
}

// --- INICIO ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 [Bot] Online como ${client.user.tag}`);
  
  // Carga de datos en segundo plano para no bloquear
  Promise.all([loadInvitesData(), loadSorteosData()]).then(() => {
    activeSorteos.forEach((s, id) => {
      const remaining = s.endTime - Date.now();
      if (remaining > 0) setTimeout(() => finalizarSorteo(id), remaining);
      else finalizarSorteo(id);
    });
  });

  joinAndStay();
  startRadio();

  // Cache de invitaciones
  client.guilds.fetch(GUILD_ID).then(g => g.invites.fetch()).then(invs => {
    invs.forEach(i => invitesCache.set(i.code, i.uses || 0));
    console.log('✅ [Invites] Cache inicializado');
  }).catch(() => {});
});

// --- EVENTOS ---
client.on('guildMemberAdd', async (m) => {
  try {
    const newInvites = await m.guild.invites.fetch();
    const used = newInvites.find(i => (i.uses || 0) > (invitesCache.get(i.code) || 0));
    newInvites.forEach(i => invitesCache.set(i.code, i.uses || 0));

    if (used && used.inviter) {
      const count = (inviteCounts.get(used.inviter.id) || 0) + 1;
      inviteCounts.set(used.inviter.id, count);
      memberInviters.set(m.id, used.inviter.id);
      saveInvitesData();
    }

    if (WELCOME_CHANNEL_ID) {
      const ch = await m.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);
      if (ch) {
        const emb = new EmbedBuilder()
          .setTitle(`${m.user.username} ¡Bienvenido! 🎉`)
          .setDescription(`Tickets: <#${TICKET_CHANNEL_ID}>\nChat: <#${CHAT_CHANNEL_ID}>\nSorteos: <#${SORTEOS_CHANNEL_ID}>`)
          .setThumbnail(m.user.displayAvatarURL())
          .setColor('#ff9cbf')
          .setFooter({ text: `${m.guild.name}` });
        ch.send({ embeds: [emb] });
      }
    }
    if (MEMBER_ROLE_ID) m.roles.add(MEMBER_ROLE_ID).catch(() => {});
  } catch {}
});

// (Resto de la lógica de tickets/sorteos se mantiene igual pero simplificada para estabilidad)
client.on('interactionCreate', async (i) => {
  if (i.isButton()) {
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
      try {
        const emb = EmbedBuilder.from(i.message.embeds[0]).setFields({ name: 'Participantes', value: `${s.participantes.size}`, inline: true });
        i.message.edit({ embeds: [emb] });
      } catch {}
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

process.on('unhandledRejection', (r) => console.error('🔴 Rejection:', r));
process.on('uncaughtException', (e) => console.error('🔴 Exception:', e));

client.login(TOKEN);
