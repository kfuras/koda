const { homedir } = require("os");
const { resolve } = require("path");

const HOME = homedir();
const KODA_HOME = process.env.KODA_HOME || resolve(HOME, ".koda");

module.exports = {
  apps: [{
    name: "koda",
    script: "/bin/bash",
    args: "-c 'source ~/.secrets.zsh 2>/dev/null; npx tsx src/index.ts'",
    cwd: __dirname,
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "1G",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: resolve(KODA_HOME, "logs/koda-error.log"),
    out_file: resolve(KODA_HOME, "logs/koda-out.log"),
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      // TICK_INTERVAL_MS is loaded from ~/.koda/.env — do NOT hardcode here.
      // pm2 env overrides dotenv on cold start, which silently breaks the tick.
    },
  }],
};
