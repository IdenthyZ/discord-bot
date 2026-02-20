@echo off
cd /d "C:\Users\alfon\OneDrive\Desktop\bot discord"
pm2 start index.js --name "discord-bot"
pm2 save
exit
