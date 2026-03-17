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

// 📡 Servidor de Salud Ligero (Siempre ayuda, aunque sea worker)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`📡 [HealthCheck] Puerto ${PORT} abierto`);
});

// 🛠 Monitorización de Memoria (Para detectar OOM en Railway)
setInterval(() => {
  const usage = process.memoryUsage();
  console.log(`📊 [Memory] RSS: ${Math.round(usage.rss / 1024 / 1024)}MB | Heap: ${Math.round(usage.heapUsed / 1024 / 1024)}MB`);
}, 60000);

// 🗄 Configuración de Redis Tolerante
const redisUrl = process.env.REDIS_URL;
let redis = null;
if (redisUrl) {
  try {
    const redisOptions = redisUrl.startsWith('rediss://') 
      ? { tls: { rejectUnauthorized: false } }
      : {};
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 5,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      reconnectOnError: (err) => true,
      ...redisOptions
    });
    redis.on('connect', () => console.log('✅ [Redis] Conectado'));
    redis.on('error', (err) => console.log('⚠️ [Redis] Error (posiblemente reintentando):', err.message));
  } catch (e) { console.error('❌ [Redis] Error crítico de inicio:', e.message); }
}

// 🛠 FFmpeg Config
let ffmpegBin = ffmpegStatic;
if (process.platform !== 'win32') {
  try {
    const systemFfmpeg = execSync('which ffmpeg').toString().trim();
    if (systemFfmpeg) ffmpegBin = systemFfmpeg;
  } catch (e) {}
}
process.env.FFMPEG_PATH = ffmpegBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;

// 🤖 Discord Config
const {
  DISCORD_TOKEN: TOKEN,
  GUILD_ID,
  VOICE_CHANNEL_ID,
  WELCOME_CHANNEL_ID,
  MEMBER_ROLE_ID,
  TICKET_CHANNEL_ID,
  CHAT_CHANNEL_ID,
  SORTEOS_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  TICKET_ADMIN_ROLE_ID = '1442336261464658096'
} = process.env;

if (!TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('❌ Faltan variables críticas');
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
    let rawInv = redis ? await redis.get('bot:invites').catch(() => null) : null;
    if (!rawInv && fs.existsSync('data/invites.json')) rawInv = fs.readFileSync('data/invites.json', 'utf-8');
    if (rawInv) {
      const data = JSON.parse(rawInv);
      if (data.counts) Object.entries(data.counts).forEach(([id, c]) => inviteCounts.set(id, Number(c)));
      if (data.members) Object.entries(data.members).forEach(([id, inv]) => memberInviters.set(id, inv));
    }

    let rawSor = redis ? await redis.get('bot:sorteos').catch(() => null) : null;
    if (!rawSor && fs.existsSync('data/sorteos.json')) rawSor = fs.readFileSync('data/sorteos.json', 'utf-8');
    if (rawSor) {
      const data = JSON.parse(rawSor);
      Object.entries(data).forEach(([id, s]) => {
        s.participantes = new Set(s.participantes || []);
        activeSorteos.set(id, s);
      });
    }
  } catch (err) { console.error('⚠️ [Datos] Error al cargar:', err.message); }
}

async function saveData() {
  try {
    const invData = JSON.stringify({ counts: Object.fromEntries(inviteCounts), members: Object.fromEntries(memberInviters) });
    const sorData = JSON.stringify(Object.fromEntries(Array.from(activeSorteos.entries()).map(([id, s]) => [id, { ...s, participantes: Array.from(s.participantes) }])));
    
    if (redis && redis.status === 'ready') {
      await redis.set('bot:invites', invData);
      await redis.set('bot:sorteos', sorData);
    } else {
      if (!fs.existsSync('data')) fs.mkdirSync('data');
      fs.writeFileSync('data/invites.json', invData);
      fs.writeFileSync('data/sorteos.json', sorData);
    }
  } catch (err) { console.error('⚠️ [Datos] Error al guardar:', err.message); }
}

// --- RADIO ---
const STREAM_URL = 'https://stream.maxiradio.mx:1033/live';
async function startRadio() {
  try {
    console.log('📻 [Radio] Cargando stream...');
    const res = await axios.get(STREAM_URL, { responseType: 'stream', timeout: 20000 });
    const { stream, type } = await demuxProbe(res.data);
    player.play(createAudioResource(stream, { inputType: type }));
    console.log('📻 [Radio] Reproduciendo');
  } catch (err) {
    console.error('⚠️ [Radio] Reintentando en 15s:', err.message);
    setTimeout(startRadio, 15000);
  }
}

player.on(AudioPlayerStatus.Idle, () => {
  console.log('📻 [Radio] Idle -> Rebotando...');
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
    connection.subscribe(player);
    console.log('✅ [Voz] Canal unido');
  } catch (err) {
    console.error('⚠️ [Voz] Error:', err.message);
    setTimeout(joinAndStay, 30000);
  }
}

// --- EVENTOS ---
client.once(Events.ClientReady, async () => {
  console.log(`🚀 [Bot] Online como ${client.user.tag}`);
  await loadData();
  joinAndStay();
  startRadio();

  activeSorteos.forEach((s, id) => {
    const rem = s.endTime - Date.now();
    setTimeout(() => finalizarSorteo(id), Math.max(rem, 1000));
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
    const emb = new EmbedBuilder().setTitle('Tickets').setDescription('Pulsa abajo para abrir un ticket.').setColor('#ff9cbf');
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_ticket').setLabel('Abrir Ticket').setStyle(ButtonStyle.Primary));
    msg.channel.send({ embeds: [emb], components: [btn] });
  }

  if (msg.content === '!sorteo') {
    const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_sorteo_modal').setLabel('Crear Sorteo').setStyle(ButtonStyle.Success));
    msg.channel.send({ content: '🎉 ¿Nuevo sorteo?', components: [btn] });
  }
});

client.on('interactionCreate', async (i) => {
  if (i.isButton()) {
    if (i.customId === 'create_ticket') {
      const modal = new ModalBuilder().setCustomId('ticket_modal').setTitle('Ticket');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('motivo').setLabel('Motivo').setStyle(TextInputStyle.Paragraph).setRequired(true)));
      return i.showModal(modal);
    }
    if (i.customId === 'open_sorteo_modal') {
      const modal = new ModalBuilder().setCustomId('sorteo_modal').setTitle('Configurar Sorteo');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('dur').setLabel('Duración (1m, 1h, 1d)').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('win').setLabel('Ganadores').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('prz').setLabel('Premio').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('req').setLabel('Invitaciones (0-3)').setStyle(TextInputStyle.Short).setRequired(true))
      );
      return i.showModal(modal);
    }
    if (i.customId === 'participar_sorteo') {
      const s = activeSorteos.get(i.message.id);
      if (!s) return i.reply({ content: '❌ No activo.', ephemeral: true });
      if (s.participantes.has(i.user.id)) {
        s.participantes.delete(i.user.id);
        i.reply({ content: 'Saliste.', ephemeral: true });
      } else {
        const req = s.requisitoInvite || 0;
        if ((inviteCounts.get(i.user.id) || 0) < req) return i.reply({ content: `❌ Necesitas ${req} invitaciones.`, ephemeral: true });
        s.participantes.add(i.user.id);
        i.reply({ content: 'Participando! 🎉', ephemeral: true });
      }
      saveData();
      const emb = EmbedBuilder.from(i.message.embeds[0]).setFields({ name: 'Participantes', value: `${s.participantes.size}`, inline: true });
      i.message.edit({ embeds: [emb] }).catch(() => {});
    }
  }

  if (i.isModalSubmit()) {
    if (i.customId === 'ticket_modal') {
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
        ch.send({ content: `${i.user} | <@&${TICKET_ADMIN_ROLE_ID}>\n**Motivo:** ${i.fields.getTextInputValue('motivo')}` });
        i.reply({ content: `Creado: ${ch}`, ephemeral: true });
      } catch (err) { i.reply({ content: '❌ Error al crear.', ephemeral: true }); }
    }
    if (i.customId === 'sorteo_modal') {
      const dur = i.fields.getTextInputValue('dur'), win = parseInt(i.fields.getTextInputValue('win')), prz = i.fields.getTextInputValue('prz'), req = parseInt(i.fields.getTextInputValue('req'));
      const match = dur.match(/^(\d+)([mhd])$/);
      if (!match) return i.reply({ content: 'Error formato (10m, 1h, 1d)', ephemeral: true });
      
      let ms = parseInt(match[1]) * 60000;
      if (match[2] === 'h') ms *= 60; if (match[2] === 'd') ms *= 24;
      const endTime = Date.now() + ms;
      
      const emb = new EmbedBuilder().setTitle('🎉 ¡SORTEO!').setDescription(`**Premio:** ${prz}\n**Ganadores:** ${win}\n**Termina:** <t:${Math.floor(endTime/1000)}:R>`).addFields({ name: 'Participantes', value: '0', inline: true }).setColor('#00FF00');
      const btn = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('participar_sorteo').setLabel('Participar').setStyle(ButtonStyle.Success).setEmoji('🎉'));
      
      const ch = SORTEOS_CHANNEL_ID ? await i.guild.channels.fetch(SORTEOS_CHANNEL_ID) : i.channel;
      const msg = await ch.send({ content: '@everyone', embeds: [emb], components: [btn] });
      
      activeSorteos.set(msg.id, { premio: prz, ganadores: win, endTime, channelId: ch.id, requisitoInvite: req, participantes: new Set() });
      saveData();
      setTimeout(() => finalizarSorteo(msg.id), ms);
      i.reply({ content: 'Publicado.', ephemeral: true });
    }
  }
});

async function finalizarSorteo(id) {
  const s = activeSorteos.get(id); if (!s) return;
  try {
    const ch = await client.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(id);
    const winners = Array.from(s.participantes).sort(() => 0.5 - Math.random()).slice(0, s.ganadores);
    const emb = EmbedBuilder.from(msg.embeds[0]).setTitle('🎉 FINALIZADO').setDescription(`**Premio:** ${s.premio}\n**Ganadores:** ${winners.map(w => `<@${w}>`).join(', ') || 'Nadie'}`).setColor('#FF0000');
    await msg.edit({ embeds: [emb], components: [] });
    if (winners.length) ch.send(`🎊 ¡Felicidades ${winners.map(w => `<@${w}>`).join(', ')}! Ganaste **${s.premio}**.`);
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
    if (ch) ch.send({ embeds: [new EmbedBuilder().setTitle(`¡Bienvenido ${m.user.username}!`).setColor('#ff9cbf').setThumbnail(m.user.displayAvatarURL())] });
  }
  if (MEMBER_ROLE_ID) m.roles.add(MEMBER_ROLE_ID).catch(() => {});
});

// Captura de apagado Railway
process.on('SIGTERM', () => { console.log('👋 [System] SIGTERM recibido (Railway apagando)'); process.exit(0); });
process.on('SIGINT', () => { console.log('👋 [System] SIGINT recibido'); process.exit(0); });
process.on('unhandledRejection', (r) => console.error('🔴 Rejection:', r));
process.on('uncaughtException', (e) => console.error('🔴 Exception:', e));

client.login(TOKEN);
