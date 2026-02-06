@echo off
REM Script para ejecutar el verificador del bot en segundo plano sin mostrar ventanas

cd /d "%~dp0"

REM Usar VBScript para ejecutar PowerShell en segundo plano sin ventana
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0verificar-bot.ps1"
