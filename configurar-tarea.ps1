$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptPath "iniciar-verificador.bat"
$taskName = "Verificador-Discord-Bot"

Write-Host "Configurando verificador automatico..." -ForegroundColor Cyan

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removiendo tarea anterior..." -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $batPath"
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

try {
    $task = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -ErrorAction Stop
    
    $task_trigger = $task.Triggers[0]
    $task_trigger.Repetition.Interval = "PT5M"
    $task_trigger.Repetition.Duration = "P365D"
    
    $task | Set-ScheduledTask -ErrorAction Stop
    
    Write-Host "EXITO: Tarea configurada correctamente" -ForegroundColor Green
    Write-Host "" -ForegroundColor Green
    Write-Host "El bot se verificara cada 5 minutos y se reiniciara si es necesario" -ForegroundColor Green
}
catch {
    Write-Host "ERROR: No se pudo crear la tarea" -ForegroundColor Red
    Write-Host $_ -ForegroundColor Red
}
