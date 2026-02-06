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

function parseClearCount(content) {
  const parts = content.trim().split(/\s+/);
  if (parts.length < 2 || parts[0] !== '!clear') return null;
  const count = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(count) || count <= 0) return null;
  return count;
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
});

client.on('messageCreate', async (message) => {
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
      await message.reply(`✅ ${member.user.tag} ha sido muteado por ${timeStr}.\n**Razón:** ${reason}`);
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

  // Comando !close (cerrar ticket)
  if (message.content.startsWith('!close')) {
    if (!message.channel.name.startsWith('ticket-')) {
      await message.reply('❌ Este comando solo se puede usar en canales de ticket.');
      return;
    }

    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
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
      const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
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
        // Crear canal de ticket
        const ticketChannel = await guild.channels.create({
          name: `ticket-${member.user.username}`,
          type: ChannelType.GuildText,
          parent: TICKET_CATEGORY_ID || null,
          topic: `Ticket de ${member.user.tag} (${member.id})`,
          permissionOverwrites: [
            {
              id: guild.id,
              deny: [PermissionsBitField.Flags.ViewChannel]
            },
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

  // Detectar si un usuario (no bot) se unió
  if (!newState?.member) {
    console.log('[User] Sin miembro');
    return;
  }
  if (newState.member.user?.bot) {
    console.log('[User] Es un bot, ignorando');
    return;
  }
  if (newState.channelId !== VOICE_CHANNEL_ID) {
    console.log(`[User] En otro canal: ${newState.channelId}`);
    return;
  }
  if (oldState.channelId === VOICE_CHANNEL_ID) {
    console.log('[User] Ya estaba en el canal');
    return;
  }

  console.log(`[Greet] Verificando cooldown para ${newState.id}`);
  const now = Date.now();
  const last = lastGreetByUser.get(newState.id) ?? 0;
  if (now - last < GREET_COOLDOWN_MS) {
    console.log(`[Greet] Cooldown activo (${now - last}ms)`);
    return;
  }

  lastGreetByUser.set(newState.id, now);

  try {
    const connection = getVoiceConnection(GUILD_ID) ?? (await joinAndStay());
    connection.subscribe(player);

    console.log(`[Greet] Usuario ${newState.member.user.username} se unió, reproduciendo saludo...`);

    // Esperar 2 segundos antes del saludo
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Guardar el estado actual si está reproduciendo
    const wasPlaying = player.state.status === AudioPlayerStatus.Playing;
    if (wasPlaying) {
      player.stop(true);
      console.log('[Greet] Radio detenida para reproducir saludo');
    }

    const text = 'Hola, identhy esta afk, o en unos segundos contesta, esta muteado';
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=es&client=gtx&textlen=${text.length}`;

    console.log('[Greet] Obteniendo TTS...');

    const response = await fetch(ttsUrl);
    console.log(`[Greet] Respuesta TTS: ${response.status}`);
    if (!response.ok || !response.body) {
      console.error('Error obteniendo TTS:', response.status);
      if (wasPlaying) {
        await startRadio();
      }
      return;
    }

    const stream = Readable.fromWeb(response.body);
    const resource = createAudioResource(stream);

    console.log('[Greet] Reproduciendo saludo...');

    // Reproducir saludo y esperar a que termine
    await new Promise((resolve) => {
      player.once(AudioPlayerStatus.Idle, resolve);
      player.play(resource);
    });

    console.log('Saludo finalizado');

    // Reanudar radio si estaba reproduciendo
    if (wasPlaying) {
      console.log('Reanudando radio...');
      await startRadio();
    }

  } catch (err) {
    console.error('Error al reproducir saludo TTS:', err);
  }
});

// Evento cuando un nuevo miembro se une al servidor
client.on('guildMemberAdd', async (member) => {
  console.log(`[Nuevo miembro] ${member.user.username} se unió al servidor`);

  // Enviar mensaje de bienvenida
  if (WELCOME_CHANNEL_ID) {
    try {
      const welcomeChannel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
      if (welcomeChannel && welcomeChannel.isTextBased()) {
        const fecha = new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
        
        const welcomeEmbed = new EmbedBuilder()
          .setTitle('Gracias por unirte a nuestra comunidad! 🎉')
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
});

client.login(TOKEN);
