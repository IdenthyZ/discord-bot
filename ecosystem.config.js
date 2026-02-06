export default {
  apps: [{
    name: 'discord-bot',
    script: './index.js',
    instances: 1,
    interpreter: 'node',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
