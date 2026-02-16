# Discord Bot 🤖

Bot de Discord con soporte para voz, tickets, sorteos y más.

## ✨ Características

- 🎵 **Streaming de audio** en canales de voz
- 🎫 **Sistema de tickets** con logs
- 🎁 **Sistema de sorteos** interactivo
- 👋 **Mensajes de bienvenida** personalizados
- 🛠️ **Comandos de moderación** (!clear, etc.)
- 🔄 **Reconexión automática** a canales de voz
- 📊 **Logs detallados** con PM2

## 🚀 Inicio Rápido

```bash
npm install
npm start
```

## ⚙️ Configuración

1. Copia `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edita `.env` con tus credenciales:
   ```env
   DISCORD_TOKEN=tu_token_de_discord
   GUILD_ID=id_de_tu_servidor
   VOICE_CHANNEL_ID=id_del_canal_de_voz
   TICKET_ADMIN_ROLE_ID=id_del_rango_que_puede_cerrar_tickets
   # ... resto de IDs
   ```

3. Para obtener los IDs:
   - Activa el **Modo Desarrollador** en Discord (Configuración → Avanzado)
   - Click derecho en servidores/canales/roles → **Copiar ID**

## 📋 Comandos del Bot

- `!clear <número>` - Borra mensajes (requiere permisos)
- `!play <URL>` - Reproduce audio en el canal de voz
- `!pause` - Pausa la reproducción
- `!resume` - Reanuda la reproducción
- `!skip` - Salta a la siguiente canción
- `!sorteo <premio> <ganadores> <tiempo>` - Crea un sorteo

## 💻 Scripts NPM

```bash
npm start           # Inicia el bot normalmente
npm run pm2:start   # Inicia con PM2
npm run pm2:stop    # Detiene el bot
npm run pm2:restart # Reinicia el bot
npm run pm2:logs    # Ver logs en tiempo real
npm run pm2:status  # Ver estado del bot
```

## 💻 Recursos del Bot

- 💾 **Uso de RAM**: ~300-500 MB
- ⚡ **CPU**: Mínimo requerido
- 📦 **Almacenamiento**: ~100 MB

## 📊 Monitoreo

```bash
# Ver logs del bot
pm2 logs discord-bot

# Ver uso de recursos
pm2 monit

# Estado del bot
pm2 status
```

## � Reinicio Automático del Bot (Cada 5 Minutos)

Para que el bot se reinicie automáticamente si se detiene en cualquier momento:

### Opción 1: Instalación Manual (Recomendado)

1. **Abre PowerShell COMO ADMINISTRADOR**
2. Ve a la carpeta del bot:
   ```powershell
   cd "C:\Users\alfon\OneDrive\Desktop\bot discord"
   ```
3. Ejecuta el configurador:
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process
   .\configurar-tarea.ps1
   ```
4. ✓ La tarea se creará automáticamente

### Opción 2: Ejecución Manual

Solo ejecuta este archivo batch cuando quieras que se verifique:
```
iniciar-verificador.bat
```

### ¿Cómo funciona?

- ✅ Verifica el estado del bot cada **5 minutos**
- ✅ Si está en línea, no hace nada
- ❌ Si se detiene, lo reinicia automáticamente
- ✅ No duplica procesos ni mata procesos activos
- 🔇 Se ejecuta en segundo plano sin ventanas

### Ver estado de la tarea programada (PowerShell Admin):

```powershell
# Ver si está registrada
Get-ScheduledTask -TaskName "Verificador-Discord-Bot"

# Ver últimas ejecuciones
Get-ScheduledTaskInfo -TaskName "Verificador-Discord-Bot"

# Remover la tarea (si es necesario)
Unregister-ScheduledTask -TaskName "Verificador-Discord-Bot" -Confirm:$false
```

## �🛠️ Requisitos del Sistema

- Node.js 18+
- FFmpeg instalado en Windows
- npm o yarn
- Windows 10/11

## 📁 Estructura del Proyecto

```
discord-bot/
├── index.js              # Código principal del bot
├── package.json          # Dependencias
├── ecosystem.config.js   # Configuración de PM2
├── .env                  # Variables de entorno (no subir a Git)
├── .env.example          # Plantilla de variables
├── README.md             # Este archivo
├── iniciar-pm2-bot.bat   # Script de inicio con PM2
└── logs/                 # Directorio de logs (se crea automáticamente)
```

## 🔒 Seguridad

- ⚠️ **NUNCA** subas tu archivo `.env` a Git
- ⚠️ **NUNCA** compartas tu `DISCORD_TOKEN`
- ✅ El `.gitignore` ya está configurado correctamente
- ✅ Usa variables de entorno para datos sensibles

## 🆘 Solución de Problemas

### El bot no inicia
```bash
# Verificar logs de error
pm2 logs discord-bot --err

# Verificar configuración
type .env
```

### Problemas de memoria
```bash
# Ver uso de memoria
pm2 info discord-bot

# Aumentar límite en ecosystem.config.js
max_memory_restart: '1G'
```

## 📝 Licencia

MIT

---

⭐ **Bot listo para ejecutar en tu ordenador**

