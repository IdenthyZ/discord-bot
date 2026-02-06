# Script para verificar si el bot está en ejecución cada 5 minutos
# Si no está corriendo, lo reinicia automáticamente

$botName = "discord-bot"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptPath "iniciar-pm2-bot.bat"

# Función para verificar si el bot está en ejecución
function Verificar-Bot {
    try {
        # Obtener el estado del bot desde pm2
        $salida = & pm2 status 2>$null | Select-String $botName
        
        if ($salida -match "online") {
            return $true
        }
        return $false
    }
    catch {
        return $false
    }
}

# Función para iniciar el bot
function Iniciar-Bot {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot no detectado. Iniciando..." -ForegroundColor Yellow
    & $batPath
    Start-Sleep -Seconds 3
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot iniciado." -ForegroundColor Green
}

# Loop infinito que verifica cada 5 minutos
while ($true) {
    if (Verificar-Bot) {
        Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Bot está en línea. ✓" -ForegroundColor Green
    }
    else {
        Iniciar-Bot
    }
    
    # Esperar 5 minutos (300 segundos)
    Start-Sleep -Seconds 300
}
