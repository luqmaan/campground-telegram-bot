module.exports = {
  apps: [
    {
      name: 'bilal69-bot',
      script: 'src/bot.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 5000,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
      error_file: `${__dirname}/logs/bilal69-bot-error.log`,
      out_file: `${__dirname}/logs/bilal69-bot-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
