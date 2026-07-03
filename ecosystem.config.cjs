// PM2 process manager config — 24/7 en un VPS.
// Uso:  pm2 start ecosystem.config.cjs   (ejecutar desde la raíz del proyecto)
// El bot carga las variables desde ./.env vía dotenv, por eso PM2 debe
// arrancarse desde el directorio raíz del repo (cwd correcto).
module.exports = {
  apps: [
    {
      name: "telegram-rag-bot",
      script: "src/telegram-bot.js",
      args: "start",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      // Reinicio con backoff si crashea en bucle
      exp_backoff_restart_delay: 200,
      max_restarts: 15,
      env: {
        NODE_ENV: "production",
      },
      out_file: "logs/bot-out.log",
      error_file: "logs/bot-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
