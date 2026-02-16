import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  demuxProbe,
} from '@discordjs/voice';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import https from 'https';
import axios from 'axios';
// Configuración de FFmpeg para Windows
const ffmpegBin = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe';
const ffprobeBin = 'C:\\ffmpeg\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe';
process.env.FFMPEG_PATH = ffmpegBin;
process.env.FFPROBE_PATH = ffprobeBin;
process.env.PRISM_MEDIA_FFMPEG_PATH = ffmpegBin;

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
const MOD_LOGS_CHANNEL_ID = process.env.MOD_LOGS_CHANNEL_ID;
const INVITES_CHANNEL_ID = process.env.INVITES_CHANNEL_ID || '1472089754332958851';
const ALLYS_CHANNEL_ID = process.env.ALLYS_CHANNEL_ID || '1472827620209987664';
const ALLYS_ADMIN_ROLE_ID = process.env.ALLYS_ADMIN_ROLE_ID || '1442336261464658096';
const MEMBER_COUNT_CATEGORY_NAME = process.env.MEMBER_COUNT_CATEGORY_NAME || '📈 • Contador';
const MEMBER_COUNT_CHANNEL_TEMPLATE = '🧑‍🤝‍🧑 Total: {count}';

if (!TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Faltan variables de entorno: DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID');
  process.exit(1);
}

console.log('[Config] MOD_LOGS_CHANNEL_ID:', MOD_LOGS_CHANNEL_ID || 'NO CONFIGURADO');

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

const queue = [];
const lastGreetByUser = new Map();
const GREET_COOLDOWN_MS = 30_000;
let pausedResource = null;
let lastTextChannel = null;
const activeSorteos = new Map(); // Almacena sorteos activos { messageId: { premio, ganadores, participantes, endTime } }
const invitesCache = new Map();
const inviteCounts = new Map();
const memberInviters = new Map();

const invitesDataPath = path.join(process.cwd(), 'data', 'invites.json');

function loadInvitesData() {
  try {
    if (!fs.existsSync(invitesDataPath)) return;
    const raw = fs.readFileSync(invitesDataPath, 'utf-8');
    const data = JSON.parse(raw);

    const counts = data?.counts || {};
    const members = data?.members || {};

    for (const [inviterId, count] of Object.entries(counts)) {
      inviteCounts.set(inviterId, Number(count) || 0);
    }

    for (const [memberId, inviterId] of Object.entries(members)) {
      memberInviters.set(memberId, inviterId);
    }
  } catch (err) {
    console.error('[Invites] Error cargando invites.json:', err);
  }
}

function saveInvitesData() {
  try {
    fs.mkdirSync(path.dirname(invitesDataPath), { recursive: true });
    const countsObj = Object.fromEntries(inviteCounts.entries());
    const membersObj = Object.fromEntries(memberInviters.entries());
    const data = { counts: countsObj, members: membersObj };
    fs.writeFileSync(invitesDataPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Invites] Error guardando invites.json:', err);
  }
}

function formatMemberCountName(count) {
  return MEMBER_COUNT_CHANNEL_TEMPLATE.replace('{count}', String(count));
}

async function ensureMemberCountChannel(guild) {
  const desiredPrefix = MEMBER_COUNT_CHANNEL_TEMPLATE.replace('{count}', '').trim();
  let category = guild.channels.cache.find(
    (ch) => ch.type === ChannelType.GuildCategory && ch.name === MEMBER_COUNT_CATEGORY_NAME
  );

  if (!category) {
    category = await guild.channels.create({
      name: MEMBER_COUNT_CATEGORY_NAME,
      type: ChannelType.GuildCategory,
    });
  }

  const existing = guild.channels.cache.find((ch) => {
    if (ch.type !== ChannelType.GuildVoice) return false;
    if (ch.parentId !== category.id) return false;
    return ch.name.startsWith(desiredPrefix);
  });

  if (existing) return existing;

  const name = formatMemberCountName(guild.memberCount);

  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.id,
        deny: [PermissionsBitField.Flags.Connect],
      },
    ],
  });
}

async function updateMemberCountChannel(guild) {
  const channel = await ensureMemberCountChannel(guild);
  const desiredName = formatMemberCountName(guild.memberCount);
  if (channel.name !== desiredName) {
    await channel.setName(desiredName);
  }
}

async function refreshInvitesCache() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const invites = await guild.invites.fetch();
  invitesCache.clear();
  for (const invite of invites.values()) {
    invitesCache.set(invite.code, invite.uses ?? 0);
  }
  return invites;
}

function parseClearCount(content) {
  const parts = content.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== '!clear') return null;
  const count = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  return count;
}

function hasTicketClosePermission(member) {
  if (!member) return false;
  const isAdministrator = member.permissions?.has(PermissionsBitField.Flags.Administrator);
  const hasTicketAdminRole = member.roles?.cache?.has(TICKET_ADMIN_ROLE_ID);
  return Boolean(isAdministrator || hasTicketAdminRole);
}

function playNext() {
  const next = queue.shift();
  if (!next) return;
  player.play(next);
}

function enqueue(resource, toFront = false) {
  if (toFront) queue.unshift(resource);
  else queue.push(resource);

  if (player.state.status !== AudioPlayerStatus.Playing) {
    playNext();
  }
}

// Función para guardar el log del ticket
async function saveTicketLog(channel, closedBy) {
  if (!TICKET_LOGS_CHANNEL_ID) return;

  try {
    // Obtener todos los mensajes del canal
    let allMessages = [];
    let lastId = null;

    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      allMessages.push(...messages.values());
      lastId = messages.last().id;

      if (messages.size < 100) break;
    }

    // Ordenar mensajes por fecha (más antiguos primero)
    allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    // Crear el contenido del log
    let logContent = `==============================================\n`;
    logContent += `TICKET: ${channel.name}\n`;
    logContent += `CERRADO POR: ${closedBy.tag}\n`;
    logContent += `FECHA DE CIERRE: ${new Date().toLocaleString('es-ES')}\n`;
    logContent += `TOTAL DE MENSAJES: ${allMessages.length}\n`;
    logContent += `==============================================\n\n`;

    for (const msg of allMessages) {
      const timestamp = new Date(msg.createdTimestamp).toLocaleString('es-ES');
      logContent += `[${timestamp}] ${msg.author.tag}: ${msg.content}\n`;
      
      // Incluir archivos adjuntos
      if (msg.attachments.size > 0) {
        msg.attachments.forEach(att => {
          logContent += `  [Archivo adjunto: ${att.url}]\n`;
        });
      }

      // Incluir embeds
      if (msg.embeds.length > 0) {
        logContent += `  [Embed: ${msg.embeds[0].title || msg.embeds[0].description || 'Sin título'}]\n`;
      }
    }

    // Crear el archivo
    const buffer = Buffer.from(logContent, 'utf-8');
    const filename = `ticket-${channel.name}-${Date.now()}.txt`;

    // Enviar al canal de logs
    const logsChannel = await channel.guild.channels.fetch(TICKET_LOGS_CHANNEL_ID);
    if (logsChannel && logsChannel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('📝 Log de Ticket Cerrado')
        .setDescription(
          `**Ticket:** ${channel.name}\n` +
          `**Cerrado por:** ${closedBy.tag}\n` +
          `**Mensajes:** ${allMessages.length}\n` +
          `**Fecha:** ${new Date().toLocaleString('es-ES')}`
        )
        .setColor('#00FF00')
        .setTimestamp();

      await logsChannel.send({
        embeds: [embed],
        files: [{ attachment: buffer, name: filename }]
      });

      console.log(`[Tickets] Log guardado para ${channel.name}`);
    }
  } catch (err) {
    console.error('Error guardando log del ticket:', err);
  }
}

function hasPermissionOverwritesChanged(oldChannel, newChannel) {
  const oldOverwrites = oldChannel.permissionOverwrites?.cache;
  const newOverwrites = newChannel.permissionOverwrites?.cache;
  if (!oldOverwrites || !newOverwrites) return false;
  if (oldOverwrites.size !== newOverwrites.size) return true;

  for (const [id, oldOverwrite] of oldOverwrites) {
    const newOverwrite = newOverwrites.get(id);
    if (!newOverwrite) return true;
    if (!oldOverwrite.allow.equals(newOverwrite.allow)) return true;
    if (!oldOverwrite.deny.equals(newOverwrite.deny)) return true;
  }

  return false;
}

async function syncTicketChannelsWithCategory(categoryChannel) {
  if (!categoryChannel || categoryChannel.type !== ChannelType.GuildCategory) {
    return { total: 0, synced: 0 };
  }

  const guild = categoryChannel.guild;
  const ticketChannels = guild.channels.cache.filter((ch) => {
    if (ch.type !== ChannelType.GuildText) return false;
    if (ch.parentId !== categoryChannel.id) return false;
    return ch.name.toLowerCase().startsWith('ticket-');
  });

  if (ticketChannels.size === 0) {
    return { total: 0, synced: 0 };
  }

  const categoryOverwrites = categoryChannel.permissionOverwrites.cache.map((overwrite) => ({
    id: overwrite.id,
    allow: overwrite.allow,
    deny: overwrite.deny,
  }));
  const categoryIds = new Set(categoryOverwrites.map((overwrite) => overwrite.id));

  let synced = 0;
  for (const ticketChannel of ticketChannels.values()) {
    try {
      const ticketSpecificOverwrites = ticketChannel.permissionOverwrites.cache
        .filter((overwrite) => !categoryIds.has(overwrite.id))
        .map((overwrite) => ({
          id: overwrite.id,
          allow: overwrite.allow,
          deny: overwrite.deny,
        }));

      await ticketChannel.permissionOverwrites.set([
        ...categoryOverwrites,
        ...ticketSpecificOverwrites,
      ]);
      synced += 1;
    } catch (err) {
      console.error(`[Tickets] Error resincronizando permisos en ${ticketChannel.name}:`, err);
    }
  }

  return { total: ticketChannels.size, synced };
}

player.on(AudioPlayerStatus.Idle, () => {
  playNext();
});

player.on('error', (error) => {
  console.error('AudioPlayerError:', error);
  if (lastTextChannel) {
    lastTextChannel.send('Hubo un error reproduciendo el audio. Verifica que la URL sea directa a un archivo/stream de audio.').catch(() => {});
  }
  try {
    player.stop(true);
  } catch {
    // noop
  }
  playNext();
});

async function createResourceFromUrl(url) {
  // Crear agente HTTPS que ignora certificados inválidos
  const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
  });

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    httpsAgent,
    timeout: 15000,
  });

  const stream = response.data;
  const { stream: probedStream, type } = await demuxProbe(stream);
  return createAudioResource(probedStream, { inputType: type });
}

const STREAM_URL = 'https://stream.maxiradio.mx:1033/live';

async function startRadio() {
  const resource = await createResourceFromUrl(STREAM_URL);
  player.play(resource);
}

async function joinAndStay() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased()) {
    throw new Error('VOICE_CHANNEL_ID no es un canal de voz válido.');
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.subscribe(player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 10_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 10_000),
      ]);
    } catch (err) {
      // Ignorar errores de IP discovery que son muy comunes y se recuperan solos
      if (err.message && err.message.includes('Cannot perform IP discovery')) {
        console.warn('[VoiceConnection] Problema de découverte IP (normal), reintentando...');
      } else {
        console.warn('[VoiceConnection] Error esperando reconexión:', err.message);
      }
      
      try {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      } catch {}
      
      // Reintento más tolerante ante fallos de conexión
      setTimeout(() => {
        joinAndStay().catch((joinErr) => {
          console.error('[VoiceConnection] Error al reintentar unión:', joinErr.message);
        });
      }, 5_000);
    }
  });

  connection.on('error', (err) => {
    // Solo loguear errores que no sean de IP discovery
    if (!err.message?.includes('Cannot perform IP discovery')) {
      console.error('[VoiceConnectionError]', err.message);
    }
  });

  return connection;
}

client.on('clientReady', async () => {
  console.log(`Conectado como ${client.user.tag}`);
  loadInvitesData();
  await joinAndStay();

  // Auto-reproducir stream de Maxiradio 24/7
  try {
    await startRadio();
    console.log('Iniciando stream de Maxiradio 24/7');
  } catch (err) {
    console.error('Error reproduciendo stream de Maxiradio:', err);
  }

  setInterval(async () => {
    const connection = getVoiceConnection(GUILD_ID);
    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
      try {
        await joinAndStay();
      } catch (err) {
        console.error('Error reintentando unión al canal:', err);
      }
    }
  }, 15_000);

  try {
    await refreshInvitesCache();
    console.log('[Invites] Cache inicial cargada');
  } catch (err) {
    console.error('[Invites] Error cargando cache inicial:', err);
  }

  try {
    await updateMemberCountChannel(await client.guilds.fetch(GUILD_ID));
    console.log('[Members] Canal contador actualizado');
  } catch (err) {
    console.error('[Members] Error actualizando canal contador:', err);
  }
});

client.on('messageCreate', async (message) => {
            // Comando !avatar (nombre o @usuario)
            if (message.content.startsWith('!avatar')) {
              let user = message.mentions.users.first();
              if (!user) {
                const args = message.content.split(/\s+/).slice(1);
                if (args.length > 0 && args[0]) {
                  // Buscar por nombre de usuario (parcial, sin @)
                  const username = args.join(' ').toLowerCase();
                  user = message.guild.members.cache.find(m => m.user.username.toLowerCase().includes(username))?.user;
                }
              }
              if (!user) user = message.author;

              const avatarEmbed = new EmbedBuilder()
                .setColor('#7289da')
                .setTitle(`Avatar de ${user.tag}`)
                .setImage(user.displayAvatarURL({ size: 512, extension: 'png', dynamic: true }))
                .setFooter({ text: 'Bot de Discord • Railway', iconURL: client.user?.avatarURL() || undefined });
              await message.reply({ embeds: [avatarEmbed] });
              return;
            }
        // Comando !comandosstaff
        if (message.content.trim() === '!comandosstaff') {
          if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            const replyMsg = await message.reply('❌ Solo el staff puede usar este comando.');
            setTimeout(() => {
              if (replyMsg) replyMsg.delete().catch(() => {});
              message.delete().catch(() => {});
            }, 3000);
            return;
          }
          const staffEmbed = new EmbedBuilder()
            .setColor('#ff4500')
            .setTitle('🛡️ Menú de Comandos Staff')
            .setDescription('**Comandos exclusivos para el staff:**')
            .addFields(
              { name: '🤝 !allys <mensaje>', value: 'Envía un mensaje al canal de allys.' },
              { name: '🧹 !clear <n>', value: 'Borra los últimos n mensajes.' },
              { name: '🔇 !mute', value: 'Silencia a un usuario.' },
              { name: '🔈 !unmute', value: 'Desilencia a un usuario.' },
              { name: '🎫 !setup-ticket', value: 'Configura el sistema de tickets.' },
              { name: '🔄 !sync-tickets', value: 'Sincroniza los tickets.' },
              { name: '❌ !close', value: 'Cierra un ticket.' },
              { name: '🎉 !sorteo <tiempo> <ganadores> <premio>', value: 'Crea un sorteo.' },
              { name: '🚫 !cancelar-sorteo <ID>', value: 'Cancela un sorteo activo.' },
              { name: '🔄 !reroll-sorteo <ID>', value: 'Elige nuevos ganadores para un sorteo.' },
              { name: '📋 !sorteos-activos', value: 'Lista los sorteos activos.' },
              { name: '👢 !kick <usuario> <razón>', value: 'Expulsa a un usuario.' },
              { name: '🔨 !ban <usuario> <razón>', value: 'Banea a un usuario.' }
            )
            .setFooter({ text: 'Bot de Discord • Railway', iconURL: client.user?.avatarURL() || undefined })
            .setThumbnail(client.user?.avatarURL() || undefined);
          const staffMsg = await message.channel.send({ embeds: [staffEmbed] });
          await message.delete().catch(() => {});
          return;
        }
    // Comando !help
    if (message.content.trim() === '!help') {
      const helpEmbed = new EmbedBuilder()
        .setColor('#ff69b4')
        .setTitle('✨ Ayuda del Bot ✨')
        .setDescription('**¡Bienvenido al bot de la comunidad!**\n\nAquí tienes la lista de comandos disponibles para todos los miembros.')
        .addFields(
          { name: '🆘 !help', value: 'Muestra este mensaje de ayuda.' },
          { name: '🖼️ !avatar (@usuario o nombre)', value: 'Muestra el avatar de un usuario o el tuyo.' }
        )
        .setFooter({ text: 'Bot de Discord • Railway', iconURL: client.user?.avatarURL() || undefined })
        .setThumbnail(client.user?.avatarURL() || undefined);
      const replyMsg = await message.reply({ embeds: [helpEmbed], ephemeral: true }).catch(() => null);
      setTimeout(() => {
        if (replyMsg && replyMsg.delete) replyMsg.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 30000);
      return;
    }
  if (!message.guild || message.author.bot) return;
  lastTextChannel = message.channel;

  // Comando !clear
  const count = parseClearCount(message.content);
  if (count) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    // Discord permite borrar hasta 100 mensajes por bulkDelete
    const amount = Math.min(count, 100);
    try {
      await message.channel.bulkDelete(amount, true);
      const reply = await message.channel.send(`Se borraron los ultimos ${amount} mensajes.`);
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 5_000);
    } catch (err) {
      console.error('Error en !clear:', err);
      await message.channel.send('No pude borrar mensajes. Revisa permisos y que no sean mensajes muy antiguos.');
    }
    return;
  }

  // Comando !allys
  if (message.content.startsWith('!allys')) {
    let replyMsg;
    try {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        replyMsg = await message.reply('❌ Solo los administradores pueden usar este comando.');
        setTimeout(() => {
          if (replyMsg) replyMsg.delete().catch(() => {});
          message.delete().catch(() => {});
        }, 3000);
        return;
      }

      const texto = message.content.slice('!allys'.length).trim();

      if (!texto) {
        replyMsg = await message.reply('❌ Uso correcto: `!allys <mensaje>`');
        setTimeout(() => {
          if (replyMsg) replyMsg.delete().catch(() => {});
          message.delete().catch(() => {});
        }, 3000);
        return;
      }

      const allysChannel = await message.guild.channels.fetch(ALLYS_CHANNEL_ID).catch(() => null);

      if (!allysChannel || !allysChannel.isTextBased()) {
        replyMsg = await message.reply('❌ No encontré el canal de allys o no es un canal de texto.');
        setTimeout(() => {
          if (replyMsg) replyMsg.delete().catch(() => {});
          message.delete().catch(() => {});
        }, 3000);
        return;
      }

      const embed = new EmbedBuilder()
        .setColor('#deaeed')
        .setDescription(texto)
        .setFooter({ text: `Enviado por ${message.author.tag}` })
        .setTimestamp();

      await allysChannel.send({ embeds: [embed] });
      replyMsg = await message.reply('✅ Mensaje enviado al canal de allys.');
      setTimeout(() => {
        if (replyMsg) replyMsg.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 3000);
    } catch (err) {
      console.error('Error en !allys:', err);
      replyMsg = await message.reply('❌ No pude enviar el mensaje al canal de allys.');
      setTimeout(() => {
        if (replyMsg) replyMsg.delete().catch(() => {});
        message.delete().catch(() => {});
      }, 3000);
    }
    return;
  }

  // Comando !mute
  if (message.content.startsWith('!mute')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const args = message.content.split(/\s+/);
    if (args.length < 3) {
      await message.reply('❌ Uso correcto: `!mute @usuario <tiempo> [razón]`\nEjemplo: `!mute @usuario 10m Spam`\nTiempos válidos: 1m, 5m, 10m, 1h, 1d');
      return;
    }

    const member = message.mentions.members.first();
    if (!member) {
      await message.reply('❌ Debes mencionar a un usuario válido.');
      return;
    }

    if (member.id === message.author.id) {
      await message.reply('❌ No puedes mutearte a ti mismo.');
      return;
    }

    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.reply('❌ No puedes mutear a un administrador.');
      return;
    }

    const timeStr = args[2];
    const reason = args.slice(3).join(' ') || 'Sin razón especificada';

    // Parsear tiempo (ej: 10m, 1h, 1d)
    const timeRegex = /^(\d+)([smhd])$/;
    const match = timeStr.match(timeRegex);
    
    if (!match) {
      await message.reply('❌ Formato de tiempo inválido. Usa: s (segundos), m (minutos), h (horas), d (días)\nEjemplo: 10m, 1h, 2d');
      return;
    }

    const timeValue = parseInt(match[1]);
    const timeUnit = match[2];
    
    let milliseconds = 0;
    switch (timeUnit) {
      case 's': milliseconds = timeValue * 1000; break;
      case 'm': milliseconds = timeValue * 60 * 1000; break;
      case 'h': milliseconds = timeValue * 60 * 60 * 1000; break;
      case 'd': milliseconds = timeValue * 24 * 60 * 60 * 1000; break;
    }

    // Discord limita el timeout a 28 días
    const maxTimeout = 28 * 24 * 60 * 60 * 1000;
    if (milliseconds > maxTimeout) {
      await message.reply('❌ El tiempo máximo es de 28 días.');
      return;
    }

    if (milliseconds < 1000) {
      await message.reply('❌ El tiempo mínimo es de 1 segundo.');
      return;
    }

    try {
      await member.timeout(milliseconds, reason);
      const reply = await message.reply(`✅ ${member.user.tag} ha sido muteado por ${timeStr}.\n**Razón:** ${reason}`);
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 4000);
      console.log(`[Mute] ${member.user.tag} muteado por ${message.author.tag} por ${timeStr}. Razón: ${reason}`);
    } catch (err) {
      console.error('Error al mutear:', err);
      await message.reply('❌ No pude mutear al usuario. Verifica que el bot tenga permisos de "Timeout Members".');
    }
    return;
  }

  // Comando !unmute
  if (message.content.startsWith('!unmute')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const member = message.mentions.members.first();
    if (!member) {
      await message.reply('❌ Debes mencionar a un usuario válido.\nUso: `!unmute @usuario`');
      return;
    }

    try {
      await member.timeout(null);
      await message.reply(`✅ ${member.user.tag} ha sido desmuteado.`);
      console.log(`[Unmute] ${member.user.tag} desmuteado por ${message.author.tag}`);
    } catch (err) {
      console.error('Error al desmutear:', err);
      await message.reply('❌ No pude desmutear al usuario.');
    }
    return;
  }

  // Comando !setup-ticket (solo administradores)
  if (message.content.startsWith('!setup-ticket')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('¡Bienvenido al apartado de tickets!')
      .setDescription(
        'Abre un ticket para recibir ayuda del Staff.\n\n' +
        '**¿Cómo funciona?**\n' +
        '- Abre ticket en en los botones que hay o abre el menú despegable y selecciona los botones que quieras.\n\n' +
        '**Normativa:**\n' +
        '🔹 **No abras ticket sin sentido.**\n' +
        '🔹 **No compartas información personal o sensible en los tickets.**\n' +
        '🔹 **No abuses del sistema de tickets para hacer spam o bromas.**\n' +
        '🔹 **Se respetuoso y paciente con nuestro equipo de staff.**'
      )
      .setColor('#ff9cbf')
      .setFooter({ text: 'Tickets de Soporte' });

    const button = new ButtonBuilder()
      .setCustomId('create_ticket')
      .setLabel('Crear Ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(button);

    try {
      await message.channel.send({ embeds: [embed], components: [row] });
      await message.delete();
      console.log('[Tickets] Panel de tickets creado');
    } catch (err) {
      console.error('Error creando panel de tickets:', err);
      await message.reply('❌ Error al crear el panel de tickets.');
    }
    return;
  }

  // Comando !sync-tickets (resincronizar permisos con la categoría)
  if (message.content.startsWith('!sync-tickets')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    if (!TICKET_CATEGORY_ID) {
      await message.reply('❌ No hay categoría de tickets configurada (`TICKET_CATEGORY_ID`).');
      return;
    }

    try {
      const category = message.guild.channels.cache.get(TICKET_CATEGORY_ID)
        || await message.guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null);

      if (!category || category.type !== ChannelType.GuildCategory) {
        await message.reply('❌ La categoría de tickets configurada no existe o no es válida.');
        return;
      }

      const result = await syncTicketChannelsWithCategory(category);
      await message.reply(`✅ Resincronización completada: ${result.synced}/${result.total} ticket(s) actualizados.`);
      console.log(`[Tickets] Resincronización manual ejecutada por ${message.author.tag}: ${result.synced}/${result.total}`);
    } catch (err) {
      console.error('[Tickets] Error en !sync-tickets:', err);
      await message.reply('❌ Error al resincronizar tickets. Revisa la consola para más detalles.');
    }
    return;
  }

  // Comando !close (cerrar ticket)
  if (message.content.startsWith('!close')) {
    if (!message.channel.name.startsWith('ticket-')) {
      await message.reply('❌ Este comando solo se puede usar en canales de ticket.');
      return;
    }

    const isAdmin = hasTicketClosePermission(message.member);
    const isTicketOwner = message.channel.topic && message.channel.topic.includes(message.author.id);

    if (!isAdmin && !isTicketOwner) {
      await message.reply('❌ Solo el creador del ticket o un administrador puede cerrarlo.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🔒 Cerrando Ticket')
      .setDescription('Este ticket se cerrará en 5 segundos...')
      .setColor('#FF0000');

    await message.channel.send({ embeds: [embed] });

    // Guardar log del ticket
    await saveTicketLog(message.channel, message.author);

    setTimeout(async () => {
      try {
        await message.channel.delete();
        console.log(`[Tickets] Ticket ${message.channel.name} cerrado por ${message.author.tag}`);
      } catch (err) {
        console.error('Error al cerrar ticket:', err);
      }
    }, 5000);
    return;
  }

  // Comando !sorteo (crear sorteos)
  if (message.content.startsWith('!sorteo')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden crear sorteos.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const args = message.content.split(/\s+/);
    if (args.length < 4) {
      await message.reply('❌ Uso correcto: `!sorteo <tiempo> <ganadores> <premio>`\nEjemplo: `!sorteo 1h 2 Discord Nitro`\nTiempos válidos: 1m, 5m, 10m, 1h, 1d, 7d');
      return;
    }

    const timeStr = args[1];
    const ganadores = parseInt(args[2]);
    const premio = args.slice(3).join(' ');

    // Validar número de ganadores
    if (isNaN(ganadores) || ganadores < 1 || ganadores > 20) {
      await message.reply('❌ El número de ganadores debe ser entre 1 y 20.');
      return;
    }

    // Parsear tiempo (ej: 10m, 1h, 1d)
    const timeRegex = /^(\d+)([mhd])$/;
    const match = timeStr.match(timeRegex);
    
    if (!match) {
      await message.reply('❌ Formato de tiempo inválido. Usa: m (minutos), h (horas), d (días)\nEjemplo: 30m, 2h, 1d');
      return;
    }

    const timeValue = parseInt(match[1]);
    const timeUnit = match[2];
    
    let milliseconds = 0;
    switch (timeUnit) {
      case 'm': milliseconds = timeValue * 60 * 1000; break;
      case 'h': milliseconds = timeValue * 60 * 60 * 1000; break;
      case 'd': milliseconds = timeValue * 24 * 60 * 60 * 1000; break;
    }

    if (milliseconds < 60000) {
      await message.reply('❌ El tiempo mínimo es de 1 minuto.');
      return;
    }

    if (milliseconds > 30 * 24 * 60 * 60 * 1000) {
      await message.reply('❌ El tiempo máximo es de 30 días.');
      return;
    }

    const endTime = Date.now() + milliseconds;
    const endTimestamp = Math.floor(endTime / 1000);

    const embed = new EmbedBuilder()
      .setTitle('🎉 SORTEO 🎉')
      .setDescription(
        `**Premio:** ${premio}\n\n` +
        `**Ganadores:** ${ganadores}\n` +
        `**Finaliza:** <t:${endTimestamp}:R>\n\n` +
        `Reacciona con 🎉 para participar!`
      )
      .setColor('#00FF00')
      .setFooter({ text: `Creado por ${message.author.tag}` })
      .setTimestamp();

    try {
      // Cambiar al canal de sorteos si está configurado
      let sorteoChannel = message.channel;
      if (SORTEOS_CHANNEL_ID) {
        sorteoChannel = await message.guild.channels.fetch(SORTEOS_CHANNEL_ID);
      }

      // Preparar mensaje con mención
      let mencionContent = '@everyone';
      if (MEMBER_ROLE_ID) {
        mencionContent = `<@&${MEMBER_ROLE_ID}>`;
      }

      const sorteoMsg = await sorteoChannel.send({ 
        content: `${mencionContent} 🎉 **¡NUEVO SORTEO!** 🎉`,
        embeds: [embed],
        allowedMentions: { parse: ['everyone', 'roles'] }
      });
      await sorteoMsg.react('🎉');

      // Guardar sorteo activo
      activeSorteos.set(sorteoMsg.id, {
        premio,
        ganadores,
        participantes: new Set(),
        endTime,
        channelId: sorteoChannel.id,
        creatorId: message.author.id
      });

      await message.reply(`✅ Sorteo creado en <#${sorteoChannel.id}>!`);
      await message.delete().catch(() => {});

      // Programar fin del sorteo
      setTimeout(async () => {
        await finalizarSorteo(sorteoMsg.id);
      }, milliseconds);

      console.log(`[Sorteo] Creado por ${message.author.tag}: ${premio} - ${ganadores} ganador(es) - Duración: ${timeStr}`);
    } catch (err) {
      console.error('Error creando sorteo:', err);
      await message.reply('❌ Error al crear el sorteo. Verifica que el canal de sorteos exista y el bot tenga permisos.');
    }
    return;
  }

  // Comando !cancelar-sorteo (cancelar sorteos activos)
  if (message.content.startsWith('!cancelar-sorteo')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden cancelar sorteos.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const args = message.content.split(/\s+/);
    if (args.length < 2) {
      await message.reply('❌ Uso correcto: `!cancelar-sorteo <ID del mensaje>`\nEjemplo: `!cancelar-sorteo 1234567890123456789`\n\nPuedes obtener el ID haciendo clic derecho en el mensaje del sorteo → Copiar ID del mensaje');
      return;
    }

    const messageId = args[1];
    const sorteo = activeSorteos.get(messageId);

    if (!sorteo) {
      await message.reply('❌ No se encontró un sorteo activo con ese ID.');
      return;
    }

    try {
      const channel = await message.guild.channels.fetch(sorteo.channelId);
      const sorteoMsg = await channel.messages.fetch(messageId);

      // Actualizar embed a cancelado
      const canceledEmbed = new EmbedBuilder()
        .setTitle('🚫 SORTEO CANCELADO 🚫')
        .setDescription(
          `**Premio:** ${sorteo.premio}\n\n` +
          `Este sorteo ha sido cancelado por un administrador.`
        )
        .setColor('#FF0000')
        .setTimestamp();

      await sorteoMsg.edit({ embeds: [canceledEmbed] });
      await sorteoMsg.reactions.removeAll().catch(() => {});

      // Remover sorteo activo
      activeSorteos.delete(messageId);

      await message.reply(`✅ Sorteo cancelado: **${sorteo.premio}**`);
      console.log(`[Sorteo] Cancelado por ${message.author.tag}: ${sorteo.premio}`);
    } catch (err) {
      console.error('Error cancelando sorteo:', err);
      await message.reply('❌ Error al cancelar el sorteo. Verifica que el ID del mensaje sea correcto.');
    }
    return;
  }

  // Comando !reroll-sorteo (elegir nuevos ganadores)
  if (message.content.startsWith('!reroll-sorteo')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden hacer reroll de sorteos.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    const args = message.content.split(/\s+/);
    if (args.length < 2) {
      await message.reply('❌ Uso correcto: `!reroll-sorteo <ID del mensaje>`\nEjemplo: `!reroll-sorteo 1234567890123456789`\n\nPuedes obtener el ID haciendo clic derecho en el mensaje del sorteo finalizado → Copiar ID del mensaje');
      return;
    }

    const messageId = args[1];

    try {
      // Buscar el mensaje del sorteo (puede estar en cualquier canal de texto)
      let sorteoMsg = null;
      let sorteoChannel = null;

      // Intentar en el canal de sorteos primero
      if (SORTEOS_CHANNEL_ID) {
        try {
          sorteoChannel = await message.guild.channels.fetch(SORTEOS_CHANNEL_ID);
          sorteoMsg = await sorteoChannel.messages.fetch(messageId);
        } catch (err) {
          // No está en el canal de sorteos, buscar en el canal actual
        }
      }

      // Si no se encontró, intentar en el canal actual
      if (!sorteoMsg) {
        sorteoChannel = message.channel;
        sorteoMsg = await sorteoChannel.messages.fetch(messageId);
      }

      // Verificar que el mensaje tenga reacción de sorteo
      const reaction = sorteoMsg.reactions.cache.get('🎉');
      if (!reaction) {
        await message.reply('❌ Este mensaje no es un sorteo válido (no tiene reacciones 🎉).');
        return;
      }

      // Obtener participantes
      const users = await reaction.users.fetch();
      const participantes = users.filter(u => !u.bot);

      if (participantes.size === 0) {
        await message.reply('❌ No hay participantes válidos en este sorteo.');
        return;
      }

      // Obtener número de ganadores del embed original
      const embed = sorteoMsg.embeds[0];
      const description = embed.description || '';
      const ganadoresMatch = description.match(/\*\*Ganadores?:\*\*\s*(\d+)/i) || description.match(/\*\*Ganador\(es\):\*\*\s*(?:<@\d+>(?:,\s*)?)+/);
      
      let numGanadores = 1;
      if (ganadoresMatch && ganadoresMatch[1]) {
        numGanadores = parseInt(ganadoresMatch[1]);
      }

      // Seleccionar nuevos ganadores aleatorios
      const participantesArray = Array.from(participantes.values());
      numGanadores = Math.min(numGanadores, participantes.size);
      const ganadores = [];

      for (let i = 0; i < numGanadores; i++) {
        const randomIndex = Math.floor(Math.random() * participantesArray.length);
        ganadores.push(participantesArray[randomIndex]);
        participantesArray.splice(randomIndex, 1);
      }

      // Anunciar nuevos ganadores
      const premio = embed.description?.match(/\*\*Premio:\*\*\s*(.+)/)?.[1]?.split('\n')[0] || 'Premio desconocido';
      
      await message.channel.send(
        `🔄 **¡REROLL DE SORTEO!** 🔄\n\n` +
        `**Nuevos ganador(es):** ${ganadores.map(g => `<@${g.id}>`).join(', ')}\n` +
        `**Premio:** ${premio}\n\n` +
        `¡Felicidades! 🎉`
      );

      console.log(`[Sorteo] Reroll por ${message.author.tag} - Nuevos ganadores: ${ganadores.map(g => g.tag).join(', ')}`);
    } catch (err) {
      console.error('Error haciendo reroll:', err);
      await message.reply('❌ Error al hacer reroll. Verifica que el ID del mensaje sea correcto y que sea un sorteo válido.');
    }
    return;
  }

  // Comando !sorteos-activos (listar sorteos activos)
  if (message.content.startsWith('!sorteos-activos')) {
    // Verificar que el usuario sea administrador
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden ver la lista de sorteos activos.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 2000);
      return;
    }

    if (activeSorteos.size === 0) {
      await message.reply('📋 No hay sorteos activos en este momento.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('📋 Sorteos Activos')
      .setColor('#00FF00')
      .setTimestamp();

    let description = '';
    for (const [messageId, sorteo] of activeSorteos) {
      const timeLeft = Math.floor((sorteo.endTime - Date.now()) / 1000);
      const endTimestamp = Math.floor(sorteo.endTime / 1000);
      description += `**Premio:** ${sorteo.premio}\n`;
      description += `**Ganadores:** ${sorteo.ganadores}\n`;
      description += `**Finaliza:** <t:${endTimestamp}:R>\n`;
      description += `**Participantes:** ${sorteo.participantes.size}\n`;
      description += `**ID:** \`${messageId}\`\n`;
      description += `**Canal:** <#${sorteo.channelId}>\n\n`;
    }

    embed.setDescription(description || 'No hay sorteos activos.');
    await message.reply({ embeds: [embed] });
    return;
  }

  // Comando !sorteo-ayuda (ayuda sobre sorteos)
  if (message.content.startsWith('!sorteo-ayuda') || message.content.startsWith('!sorteos-ayuda')) {
    const embed = new EmbedBuilder()
      .setTitle('🎉 Sistema de Sorteos - Ayuda')
      .setDescription('Lista de comandos disponibles para gestionar sorteos:')
      .setColor('#FFD700')
      .addFields(
        {
          name: '📝 Crear Sorteo',
          value: '`!sorteo <tiempo> <ganadores> <premio>`\n' +
                 'Ejemplo: `!sorteo 1h 2 Discord Nitro`\n' +
                 'Tiempos: 1m, 30m, 1h, 12h, 1d, 7d, etc.\n' +
                 '🔐 *Solo administradores*'
        },
        {
          name: '🗑️ Cancelar Sorteo',
          value: '`!cancelar-sorteo <ID del mensaje>`\n' +
                 'Ejemplo: `!cancelar-sorteo 1234567890123456789`\n' +
                 'Obtén el ID haciendo clic derecho en el sorteo → Copiar ID\n' +
                 '🔐 *Solo administradores*'
        },
        {
          name: '🔄 Reroll (Nuevos Ganadores)',
          value: '`!reroll-sorteo <ID del mensaje>`\n' +
                 'Elige nuevos ganadores aleatorios del mismo sorteo\n' +
                 '🔐 *Solo administradores*'
        },
        {
          name: '📋 Ver Sorteos Activos',
          value: '`!sorteos-activos`\n' +
                 'Muestra todos los sorteos que están en curso\n' +
                 '🔐 *Solo administradores*'
        },
        {
          name: '🎯 Cómo Participar',
          value: 'Reacciona con 🎉 en el mensaje del sorteo\n' +
                 'Para retirarte, quita tu reacción antes de que termine'
        }
      )
      .setFooter({ text: 'Sistema de Sorteos' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
    return;
  }

  // Comando !kick (expulsar usuario) - Solo administradores
  if (message.content.startsWith('!kick')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 3000);
      return;
    }

    const args = message.content.split(/\s+/);
    const member = message.mentions.members.first();
    const reason = args.slice(2).join(' ') || 'Sin razón especificada';

    if (!member) {
      await message.reply('❌ Debes mencionar a un usuario válido.\nUso: `!kick @usuario [razón]`');
      return;
    }

    if (member.id === message.author.id) {
      await message.reply('❌ No puedes expulsarte a ti mismo.');
      return;
    }

    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.reply('❌ No puedes expulsar a un administrador.');
      return;
    }

    try {
      await member.kick(reason);
      const reply = await message.reply(`✅ ${member.user.tag} ha sido expulsado.\n**Razón:** ${reason}`);
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 4000);
      console.log(`[Kick] ${member.user.tag} expulsado por ${message.author.tag}. Razón: ${reason}`);
    } catch (err) {
      console.error('Error al expulsar:', err);
      await message.reply('❌ No pude expulsar al usuario. Verifica que el bot tenga permisos.');
    }
    return;
  }

  // Comando !ban (banear usuario) - Solo administradores
  if (message.content.startsWith('!ban')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.delete().catch(() => {});
      const reply = await message.reply('❌ Solo los administradores pueden usar este comando.');
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 3000);
      return;
    }

    const args = message.content.split(/\s+/);
    const member = message.mentions.members.first();
    const reason = args.slice(2).join(' ') || 'Sin razón especificada';

    if (!member) {
      await message.reply('❌ Debes mencionar a un usuario válido.\nUso: `!ban @usuario [razón]`');
      return;
    }

    if (member.id === message.author.id) {
      await message.reply('❌ No puedes banearte a ti mismo.');
      return;
    }

    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await message.reply('❌ No puedes banear a un administrador.');
      return;
    }

    try {
      await member.ban({ reason });
      const reply = await message.reply(`✅ ${member.user.tag} ha sido baneado.\n**Razón:** ${reason}`);
      setTimeout(() => {
        reply.delete().catch(() => {});
      }, 4000);
      console.log(`[Ban] ${member.user.tag} baneado por ${message.author.tag}. Razón: ${reason}`);
    } catch (err) {
      console.error('Error al banear:', err);
      await message.reply('❌ No pude banear al usuario. Verifica que el bot tenga permisos.');
    }
    return;
  }
});

// Listener para los botones de tickets
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    // Handler para botón de cerrar ticket
    if (interaction.customId === 'close_ticket') {
      const channel = interaction.channel;
      
      if (!channel.name.startsWith('ticket-')) {
        await interaction.reply({
          content: '❌ Este botón solo funciona en canales de ticket.',
          ephemeral: true
        });
        return;
      }

      const member = interaction.member;
      const isAdmin = hasTicketClosePermission(member);
      const isTicketOwner = channel.topic && channel.topic.includes(member.id);

      if (!isAdmin && !isTicketOwner) {
        await interaction.reply({
          content: '❌ Solo el creador del ticket o un administrador puede cerrarlo.',
          ephemeral: true
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🔒 Cerrando Ticket')
        .setDescription('Este ticket se cerrará en 5 segundos...')
        .setColor('#FF0000');

      await interaction.reply({ embeds: [embed] });

      // Guardar log del ticket
      await saveTicketLog(channel, member.user);

      setTimeout(async () => {
        try {
          await channel.delete();
          console.log(`[Tickets] Ticket ${channel.name} cerrado por ${member.user.tag}`);
        } catch (err) {
          console.error('Error al cerrar ticket:', err);
        }
      }, 5000);
      return;
    }

    // Handler para botón de crear ticket
    if (interaction.customId === 'create_ticket') {
      const guild = interaction.guild;
      const member = interaction.member;

      // Verificar si el usuario ya tiene un ticket abierto
      const existingTicket = guild.channels.cache.find((ch) => {
        if (ch.type !== ChannelType.GuildText) return false;
        const isTicketChannel = ch.name.toLowerCase().startsWith('ticket-');
        const hasOwnerId = ch.topic && ch.topic.includes(member.id);
        const matchesName = ch.name.toLowerCase() === `ticket-${member.user.username.toLowerCase()}`;
        return isTicketChannel && (hasOwnerId || matchesName);
      });

      if (existingTicket) {
        await interaction.reply({
          content: `❌ Ya tienes un ticket abierto: ${existingTicket}`,
          ephemeral: true
        });
        return;
      }

      // Mostrar modal para que el usuario escriba el motivo
      const modal = new ModalBuilder()
        .setCustomId('ticket_modal')
        .setTitle('Crear Ticket de Soporte');

      const motivoInput = new TextInputBuilder()
        .setCustomId('motivo_ticket')
        .setLabel('¿Cuál es el motivo de tu ticket?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Describe tu problema o consulta aquí...')
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(1000);

      const row = new ActionRowBuilder().addComponents(motivoInput);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }
  }

  // Handler para el modal de crear ticket
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'ticket_modal') {
      const guild = interaction.guild;
      const member = interaction.member;
      const motivo = interaction.fields.getTextInputValue('motivo_ticket');

      // Verificar nuevamente si ya tiene ticket abierto
      const existingTicket = guild.channels.cache.find((ch) => {
        if (ch.type !== ChannelType.GuildText) return false;
        const isTicketChannel = ch.name.toLowerCase().startsWith('ticket-');
        const hasOwnerId = ch.topic && ch.topic.includes(member.id);
        const matchesName = ch.name.toLowerCase() === `ticket-${member.user.username.toLowerCase()}`;
        return isTicketChannel && (hasOwnerId || matchesName);
      });

      if (existingTicket) {
        await interaction.reply({
          content: `❌ Ya tienes un ticket abierto: ${existingTicket}`,
          ephemeral: true
        });
        return;
      }

      try {
        const ticketCategory = TICKET_CATEGORY_ID
          ? guild.channels.cache.get(TICKET_CATEGORY_ID) || await guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null)
          : null;

        const categoryOverwrites = ticketCategory?.permissionOverwrites?.cache
          ? ticketCategory.permissionOverwrites.cache
            .filter((overwrite) => overwrite.id !== member.id && overwrite.id !== client.user.id)
            .map((overwrite) => ({
              id: overwrite.id,
              allow: overwrite.allow,
              deny: overwrite.deny,
            }))
          : [];

        // Crear canal de ticket
        const ticketChannel = await guild.channels.create({
          name: `ticket-${member.user.username}`,
          type: ChannelType.GuildText,
          parent: ticketCategory?.id || null,
          topic: `Ticket de ${member.user.tag} (${member.id})`,
          permissionOverwrites: [
            ...categoryOverwrites,
            {
              id: member.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory
              ]
            },
            {
              id: client.user.id,
              allow: [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ReadMessageHistory
              ]
            }
          ]
        });

        // Dar permisos a administradores
        const adminRole = guild.roles.cache.find(
          (role) => role.permissions.has(PermissionsBitField.Flags.Administrator)
        );
        if (adminRole) {
          await ticketChannel.permissionOverwrites.create(adminRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          });
        }

        const ticketAdminRole = guild.roles.cache.get(TICKET_ADMIN_ROLE_ID);
        if (ticketAdminRole) {
          await ticketChannel.permissionOverwrites.create(ticketAdminRole, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          });
        }

        const welcomeEmbed = new EmbedBuilder()
          .setTitle(`🎫 Ticket de ${member.user.username}`)
          .setDescription(
            `Hola ${member}, bienvenido a tu ticket de soporte.\n\n` +
            `Por favor describe tu problema o consulta y un miembro del staff te ayudará pronto.`
          )
          .setColor('#87CEEB')
          .setTimestamp();

        const closeButton = new ButtonBuilder()
          .setCustomId('close_ticket')
          .setLabel('Cerrar Ticket')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger);

        const ticketRow = new ActionRowBuilder().addComponents(closeButton);

        await ticketChannel.send({ content: `${member}`, embeds: [welcomeEmbed], components: [ticketRow] });

        // Enviar el motivo del ticket
        const motivoEmbed = new EmbedBuilder()
          .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
          .setDescription(`**Motivo del ticket:**\n${motivo}`)
          .setColor('#87CEEB')
          .setTimestamp();

        await ticketChannel.send({ embeds: [motivoEmbed] });

        await interaction.reply({
          content: `✅ Tu ticket ha sido creado: ${ticketChannel}`,
          ephemeral: true
        });

        console.log(`[Tickets] Ticket creado para ${member.user.tag}`);
      } catch (err) {
        console.error('Error creando ticket:', err);
        await interaction.reply({
          content: '❌ Error al crear el ticket. Contacta a un administrador.',
          ephemeral: true
        });
      }
      return;
    }
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  try {
    if (!TICKET_CATEGORY_ID) return;
    if (newChannel.id !== TICKET_CATEGORY_ID) return;
    if (newChannel.type !== ChannelType.GuildCategory) return;
    if (!hasPermissionOverwritesChanged(oldChannel, newChannel)) return;

    const result = await syncTicketChannelsWithCategory(newChannel);
    console.log(`[Tickets] Permisos resincronizados en tickets abiertos tras cambios en categoría: ${result.synced}/${result.total}`);
  } catch (err) {
    console.error('[Tickets] Error en resincronización automática de permisos:', err);
  }
});

// Función para finalizar sorteo y elegir ganadores
async function finalizarSorteo(messageId) {
  const sorteo = activeSorteos.get(messageId);
  if (!sorteo) return;

  try {
    const channel = await client.channels.fetch(sorteo.channelId);
    const message = await channel.messages.fetch(messageId);

    // Obtener todos los usuarios que reaccionaron con 🎉 (excluyendo bots)
    const reaction = message.reactions.cache.get('🎉');
    if (!reaction) {
      await channel.send(`❌ El sorteo de **${sorteo.premio}** terminó sin participantes.`);
      activeSorteos.delete(messageId);
      return;
    }

    const users = await reaction.users.fetch();
    const participantes = users.filter(u => !u.bot);

    if (participantes.size === 0) {
      await channel.send(`❌ El sorteo de **${sorteo.premio}** terminó sin participantes válidos.`);
      activeSorteos.delete(messageId);
      return;
    }

    // Seleccionar ganadores aleatorios
    const participantesArray = Array.from(participantes.values());
    const numGanadores = Math.min(sorteo.ganadores, participantes.size);
    const ganadores = [];

    for (let i = 0; i < numGanadores; i++) {
      const randomIndex = Math.floor(Math.random() * participantesArray.length);
      ganadores.push(participantesArray[randomIndex]);
      participantesArray.splice(randomIndex, 1);
    }

    // Actualizar embed del sorteo a finalizado
    const endedEmbed = new EmbedBuilder()
      .setTitle('🎉 SORTEO FINALIZADO 🎉')
      .setDescription(
        `**Premio:** ${sorteo.premio}\n\n` +
        `**Ganador(es):** ${ganadores.map(g => `<@${g.id}>`).join(', ')}\n\n` +
        `**Participantes:** ${participantes.size}`
      )
      .setColor('#FFD700')
      .setTimestamp();

    await message.edit({ embeds: [endedEmbed] });

    // Anunciar ganadores
    const anuncio = await channel.send(
      `🎊 **¡SORTEO TERMINADO!** 🎊\n\n` +
      `**${ganadores.map(g => `<@${g.id}>`).join(', ')}** ${ganadores.length > 1 ? 'han' : 'ha'} ganado: **${sorteo.premio}**!\n\n` +
      `¡Felicidades! 🎉`
    );

    console.log(`[Sorteo] Finalizado: ${sorteo.premio} - Ganadores: ${ganadores.map(g => g.tag).join(', ')}`);
    activeSorteos.delete(messageId);
  } catch (err) {
    // Si el mensaje fue eliminado (error 10008), simplemente limpiar el sorteo
    if (err.code === 10008) {
      console.log(`[Sorteo] Mensaje eliminado, limpiando sorteo: ${sorteo.premio}`);
      activeSorteos.delete(messageId);
      return;
    }
    console.error('Error finalizando sorteo:', err);
    activeSorteos.delete(messageId);
  }
}

// Listener para reacciones (para participar en sorteos)
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;

  // Si la reacción es parcial, obtener el mensaje completo
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (err) {
      console.error('Error fetching reaction:', err);
      return;
    }
  }

  // Verificar si es un sorteo activo
  if (activeSorteos.has(reaction.message.id) && reaction.emoji.name === '🎉') {
    const sorteo = activeSorteos.get(reaction.message.id);
    sorteo.participantes.add(user.id);
    console.log(`[Sorteo] ${user.tag} participó en: ${sorteo.premio}`);
  }
});

// Listener para cuando remueven reacciones
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;

  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (err) {
      console.error('Error fetching reaction:', err);
      return;
    }
  }

  // Remover participante si quita su reacción
  if (activeSorteos.has(reaction.message.id) && reaction.emoji.name === '🎉') {
    const sorteo = activeSorteos.get(reaction.message.id);
    sorteo.participantes.delete(user.id);
    console.log(`[Sorteo] ${user.tag} se retiró de: ${sorteo.premio}`);
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Solo loggear si hay cambio real de canal
  if (oldState.channelId !== newState.channelId) {
    console.log(`[voiceStateUpdate] ${newState.member?.user?.username || 'unknown'}: ${oldState.channelId} → ${newState.channelId}`);
  }

  // Detectar si el bot fue desconectado/movido de canal
  if (oldState.id === client.user.id && newState.id === client.user.id) {
    // Solo actuar si cambió de canal
    if (oldState.channelId !== newState.channelId && newState.channelId !== VOICE_CHANNEL_ID) {
      console.log('[Bot] Desconectado del canal de voz, reconectando...');
      try {
        await joinAndStay();
      } catch (err) {
        console.error('Error al re-unir tras voiceStateUpdate:', err);
      }
    }
    return;
  }
});

// Evento cuando un nuevo miembro se une al servidor
client.on('guildMemberAdd', async (member) => {
  console.log(`[Nuevo miembro] ${member.user.username} se unió al servidor`);

  try {
    const guild = member.guild;
    const newInvites = await guild.invites.fetch();
    const usedInvite = newInvites.find(
      (inv) => (inv.uses ?? 0) > (invitesCache.get(inv.code) ?? 0)
    );

    invitesCache.clear();
    for (const invite of newInvites.values()) {
      invitesCache.set(invite.code, invite.uses ?? 0);
    }

    const invitesChannel = INVITES_CHANNEL_ID
      ? await guild.channels.fetch(INVITES_CHANNEL_ID)
      : null;

    if (usedInvite && usedInvite.inviter?.id) {
      const inviterId = usedInvite.inviter.id;
      const currentCount = inviteCounts.get(inviterId) || 0;
      const newCount = currentCount + 1;
      inviteCounts.set(inviterId, newCount);
      memberInviters.set(member.id, inviterId);
      saveInvitesData();

      if (invitesChannel && invitesChannel.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 Nueva invitacion')
          .setDescription(
            `${member} fue invitado por ${usedInvite.inviter}.`
          )
          .addFields(
            { name: 'Invitaciones', value: `${newCount}`, inline: true },
            { name: 'Codigo', value: usedInvite.code, inline: true }
          )
          .setColor('#B7FF00')
          .setTimestamp();

        await invitesChannel.send({ embeds: [embed] });
      }
    } else if (invitesChannel && invitesChannel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('🎉 Nueva invitacion')
        .setDescription(`${member} se unio, pero no se pudo detectar la invitacion.`)
        .setColor('#B7FF00')
        .setTimestamp();

      await invitesChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[Invites] Error procesando invitacion:', err);
  }

  // Enviar mensaje de bienvenida
  if (WELCOME_CHANNEL_ID) {
    try {
      const welcomeChannel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
      if (welcomeChannel && welcomeChannel.isTextBased()) {
        const fecha = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        
        const welcomeEmbed = new EmbedBuilder()
          .setTitle(`${member.user.username} ¡Gracias por unirte a nuestra comunidad! 🎉`)
          .setDescription(
            `Cualquier cosa avisar en | <#${TICKET_CHANNEL_ID}>\n` +
            `Plática con los usuarios | <#${CHAT_CHANNEL_ID}>\n` +
            `Participa en sorteos | <#${SORTEOS_CHANNEL_ID}>`
          )
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 128 }))
          .setColor('#ff9cbf')
          .setFooter({ text: `${member.guild.name} • Bienvenido • ${fecha}` });

        await welcomeChannel.send({ embeds: [welcomeEmbed] });
        console.log(`[Bienvenida] Mensaje enviado para ${member.user.username}`);
      }
    } catch (err) {
      console.error('Error enviando mensaje de bienvenida:', err);
    }
  }

  // Asignar rol de miembro
  if (MEMBER_ROLE_ID) {
    try {
      const role = await member.guild.roles.fetch(MEMBER_ROLE_ID);
      if (role) {
        await member.roles.add(role);
        console.log(`[Rol] Rol "${role.name}" asignado a ${member.user.username}`);
      } else {
        console.error('No se encontró el rol con el ID especificado');
      }
    } catch (err) {
      console.error('Error asignando rol de miembro:', err);
    }
  }

  try {
    await updateMemberCountChannel(member.guild);
  } catch (err) {
    console.error('[Members] Error actualizando canal contador (join):', err);
  }
});

// Evento cuando un miembro empieza a boostear el servidor
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (!oldMember.premiumSince && newMember.premiumSince) {
    if (!WELCOME_CHANNEL_ID) return;

    try {
      const boostChannel = await newMember.guild.channels.fetch(WELCOME_CHANNEL_ID);
      if (boostChannel && boostChannel.isTextBased()) {
        const boostEmbed = new EmbedBuilder()
          .setTitle('🚀 ¡Nuevo Boost!')
          .setDescription(
            `Gracias ${newMember} por impulsar **${newMember.guild.name}**.\n` +
            '¡Tu apoyo ayuda mucho a la comunidad!'
          )
          .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true, size: 128 }))
          .setColor('#F47FFF')
          .setTimestamp();

        await boostChannel.send({ embeds: [boostEmbed] });
        console.log(`[Boost] ${newMember.user.tag} empezó a boostear`);
      }
    } catch (err) {
      console.error('Error enviando mensaje de boost:', err);
    }
  }
});

// Evento cuando un miembro se va (restar invitacion)
client.on('guildMemberRemove', async (member) => {
  const inviterId = memberInviters.get(member.id);
  if (!inviterId) return;

  const currentCount = inviteCounts.get(inviterId) || 0;
  const newCount = Math.max(0, currentCount - 1);
  inviteCounts.set(inviterId, newCount);
  memberInviters.delete(member.id);
  saveInvitesData();

  try {
    const invitesChannel = INVITES_CHANNEL_ID
      ? await member.guild.channels.fetch(INVITES_CHANNEL_ID)
      : null;

    if (invitesChannel && invitesChannel.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle('📉 Invitacion restada')
        .setDescription(
          `${member.user.tag} se fue. Se desconto una invitacion a <@${inviterId}>.`
        )
        .addFields({ name: 'Invitaciones', value: `${newCount}`, inline: true })
        .setColor('#B7FF00')
        .setTimestamp();

      await invitesChannel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('[Invites] Error enviando log de salida:', err);
  }

  try {
    await updateMemberCountChannel(member.guild);
  } catch (err) {
    console.error('[Members] Error actualizando canal contador (leave):', err);
  }
});

// ====================================
// SISTEMA DE LOGS DE MODERACIÓN
// ====================================

// Función para enviar logs al canal de moderación
async function sendModLog(guild, embed) {
  if (!MOD_LOGS_CHANNEL_ID) {
    console.warn('[Mod Logs] MOD_LOGS_CHANNEL_ID no configurado');
    return;
  }
  
  try {
    const logChannel = await guild.channels.fetch(MOD_LOGS_CHANNEL_ID);
    if (!logChannel) {
      console.error(`[Mod Logs] No se encontró el canal ${MOD_LOGS_CHANNEL_ID}`);
      return;
    }
    if (!logChannel.isTextBased()) {
      console.error(`[Mod Logs] El canal ${MOD_LOGS_CHANNEL_ID} no es un canal de texto`);
      return;
    }
    await logChannel.send({ embeds: [embed] });
    console.log('[Mod Logs] Log enviado correctamente');
  } catch (err) {
    console.error('[Mod Logs] Error enviando log:', err.message);
  }
}

// Log: Usuario baneado
client.on('guildBanAdd', async (ban) => {
  console.log(`[Mod Logs] Evento guildBanAdd disparado para ${ban.user.tag}`);
  try {
    const auditLogs = await ban.guild.fetchAuditLogs({
      limit: 1,
      type: 22, // MEMBER_BAN_ADD
    });
    
    const banLog = auditLogs.entries.first();
    const executor = banLog?.executor || { tag: 'Desconocido' };
    const reason = ban.reason || 'No especificada';
    
    const embed = new EmbedBuilder()
      .setTitle('🔨 Usuario Baneado')
      .setColor('#ff0000')
      .addFields(
        { name: '👤 Usuario', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
        { name: '👮 Moderador', value: executor.tag, inline: true },
        { name: '📋 Razón', value: reason, inline: false }
      )
      .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
      .setTimestamp()
      .setFooter({ text: 'Sistema de logs de moderación' });
    
    await sendModLog(ban.guild, embed);
    console.log(`[Mod Logs] Usuario baneado: ${ban.user.tag} por ${executor.tag}`);
  } catch (err) {
    console.error('[Mod Logs] Error en log de ban:', err);
  }
});

// Log: Ban removido
client.on('guildBanRemove', async (ban) => {
  try {
    const auditLogs = await ban.guild.fetchAuditLogs({
      limit: 1,
      type: 23, // MEMBER_BAN_REMOVE
    });
    
    const unbanLog = auditLogs.entries.first();
    const executor = unbanLog?.executor || { tag: 'Desconocido' };
    
    const embed = new EmbedBuilder()
      .setTitle('✅ Ban Removido')
      .setColor('#00ff00')
      .addFields(
        { name: '👤 Usuario', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
        { name: '👮 Moderador', value: executor.tag, inline: true }
      )
      .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
      .setTimestamp()
      .setFooter({ text: 'Sistema de logs de moderación' });
    
    await sendModLog(ban.guild, embed);
    console.log(`[Mod Logs] Ban removido: ${ban.user.tag} por ${executor.tag}`);
  } catch (err) {
    console.error('[Mod Logs] Error en log de unban:', err);
  }
});

// Log: Usuario expulsado o abandonó el servidor
client.on('guildMemberRemove', async (member) => {
  try {
    // Esperar un poco para que el audit log se actualice
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const auditLogs = await member.guild.fetchAuditLogs({
      limit: 1,
      type: 20, // MEMBER_KICK
    });
    
    const kickLog = auditLogs.entries.first();
    
    // Si fue hace menos de 5 segundos, es un kick
    if (kickLog && kickLog.target.id === member.id && Date.now() - kickLog.createdTimestamp < 5000) {
      const executor = kickLog.executor;
      const reason = kickLog.reason || 'No especificada';
      
      const embed = new EmbedBuilder()
        .setTitle('👢 Usuario Expulsado')
        .setColor('#ff9900')
        .addFields(
          { name: '👤 Usuario', value: `${member.user.tag} (${member.id})`, inline: true },
          { name: '👮 Moderador', value: executor.tag, inline: true },
          { name: '📋 Razón', value: reason, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Sistema de logs de moderación' });
      
      await sendModLog(member.guild, embed);
      console.log(`[Mod Logs] Usuario expulsado: ${member.user.tag} por ${executor.tag}`);
    }
  } catch (err) {
    console.error('[Mod Logs] Error en log de kick:', err);
  }
});

// Log: Timeout (aislamiento temporal)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const oldTimeout = oldMember.communicationDisabledUntil;
    const newTimeout = newMember.communicationDisabledUntil;
    
    // Si se agregó un timeout
    if (!oldTimeout && newTimeout) {
      const auditLogs = await newMember.guild.fetchAuditLogs({
        limit: 1,
        type: 24, // MEMBER_UPDATE
      });
      
      const timeoutLog = auditLogs.entries.first();
      const executor = timeoutLog?.executor || { tag: 'Desconocido' };
      const reason = timeoutLog?.reason || 'No especificada';
      const duration = Math.round((newTimeout - Date.now()) / 1000 / 60); // minutos
      
      const embed = new EmbedBuilder()
        .setTitle('⏰ Timeout Aplicado')
        .setColor('#ffcc00')
        .addFields(
          { name: '👤 Usuario', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
          { name: '👮 Moderador', value: executor.tag, inline: true },
          { name: '⏱️ Duración', value: `${duration} minutos`, inline: true },
          { name: '📋 Razón', value: reason, inline: false }
        )
        .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Sistema de logs de moderación' });
      
      await sendModLog(newMember.guild, embed);
      console.log(`[Mod Logs] Timeout aplicado: ${newMember.user.tag} por ${executor.tag} (${duration}min)`);
    }
    
    // Si se removió un timeout
    if (oldTimeout && !newTimeout && oldTimeout > Date.now()) {
      const auditLogs = await newMember.guild.fetchAuditLogs({
        limit: 1,
        type: 24, // MEMBER_UPDATE
      });
      
      const timeoutLog = auditLogs.entries.first();
      const executor = timeoutLog?.executor || { tag: 'Desconocido' };
      
      const embed = new EmbedBuilder()
        .setTitle('✅ Timeout Removido')
        .setColor('#00ff00')
        .addFields(
          { name: '👤 Usuario', value: `${newMember.user.tag} (${newMember.id})`, inline: true },
          { name: '👮 Moderador', value: executor.tag, inline: true }
        )
        .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp()
        .setFooter({ text: 'Sistema de logs de moderación' });
      
      await sendModLog(newMember.guild, embed);
      console.log(`[Mod Logs] Timeout removido: ${newMember.user.tag} por ${executor.tag}`);
    }
  } catch (err) {
    console.error('[Mod Logs] Error en log de timeout:', err);
  }
});

// Log: Mensaje eliminado
client.on('messageDelete', async (message) => {
  try {
    // Ignorar mensajes de bots o sin contenido
    if (!message.guild || message.author?.bot) return;
    
    const auditLogs = await message.guild.fetchAuditLogs({
      limit: 1,
      type: 72, // MESSAGE_DELETE
    });
    
    const deleteLog = auditLogs.entries.first();
    let executor = { tag: 'Usuario (auto-eliminado)' };
    
    // Si fue eliminado por un moderador (hace menos de 3 segundos)
    if (deleteLog && Date.now() - deleteLog.createdTimestamp < 3000) {
      executor = deleteLog.executor;
    }
    
    const content = message.content || '[Sin contenido de texto]';
    const truncatedContent = content.length > 1000 ? content.substring(0, 1000) + '...' : content;
    
    const embed = new EmbedBuilder()
      .setTitle('🗑️ Mensaje Eliminado')
      .setColor('#ff6600')
      .addFields(
        { name: '👤 Autor', value: message.author ? `${message.author.tag} (${message.author.id})` : 'Desconocido', inline: true },
        { name: '🗑️ Eliminado por', value: executor.tag, inline: true },
        { name: '📍 Canal', value: `<#${message.channel.id}>`, inline: true },
        { name: '💬 Contenido', value: truncatedContent, inline: false }
      )
      .setTimestamp()
      .setFooter({ text: `ID del mensaje: ${message.id}` });
    
    if (message.author) {
      embed.setThumbnail(message.author.displayAvatarURL({ dynamic: true }));
    }
    
    await sendModLog(message.guild, embed);
  } catch (err) {
    console.error('[Mod Logs] Error en log de mensaje eliminado:', err);
  }
});

// Log: Múltiples mensajes eliminados (purge)
client.on('messageDeleteBulk', async (messages) => {
  try {
    const guild = messages.first()?.guild;
    if (!guild) return;
    
    const auditLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: 73, // MESSAGE_BULK_DELETE
    });
    
    const bulkDeleteLog = auditLogs.entries.first();
    const executor = bulkDeleteLog?.executor || { tag: 'Desconocido' };
    const channel = messages.first()?.channel;
    
    const embed = new EmbedBuilder()
      .setTitle('🧹 Purga de Mensajes')
      .setColor('#ff0066')
      .addFields(
        { name: '📊 Cantidad', value: `${messages.size} mensajes`, inline: true },
        { name: '👮 Moderador', value: executor.tag, inline: true },
        { name: '📍 Canal', value: channel ? `<#${channel.id}>` : 'Desconocido', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Sistema de logs de moderación' });
    
    await sendModLog(guild, embed);
    console.log(`[Mod Logs] Purga de mensajes: ${messages.size} mensajes por ${executor.tag}`);
  } catch (err) {
    console.error('[Mod Logs] Error en log de purga:', err);
  }
});

client.login(TOKEN);
