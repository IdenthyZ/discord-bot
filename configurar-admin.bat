@echo off
REM Ejecutar PowerShell como Administrador para configurar la tarea

powershell -Command "Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force"

REM Ejecutar con permisos elevados
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0configurar-tarea.ps1\"' -Verb RunAs -Wait"

echo.
echo Configuracion completada. Presiona cualquier tecla para cerrar...
pause >nul
