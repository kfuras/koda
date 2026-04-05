module.exports = {
  apps: [{
    name: "koda",
    script: "/bin/bash",
    args: "-c 'source ~/.secrets.zsh 2>/dev/null; npx tsx src/index.ts'",
    cwd: "/Users/YOUR_USERNAME/code/koda",
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "1G",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "/Users/YOUR_USERNAME/.koda/logs/koda-error.log",
    out_file: "/Users/YOUR_USERNAME/.koda/logs/koda-out.log",
    merge_logs: true,
    env: {
      NODE_ENV: "production",
      TICK_INTERVAL_MS: "0",
    },
  }],
};
