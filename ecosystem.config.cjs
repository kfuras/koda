module.exports = {
  apps: [{
    name: "koda",
    script: "npx",
    args: "tsx src/index.ts",
    cwd: "/Users/YOUR_USERNAME/code/koda",
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "1G",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "/Users/YOUR_USERNAME/code/content-hub/data/logs/koda-error.log",
    out_file: "/Users/YOUR_USERNAME/code/content-hub/data/logs/koda-out.log",
    merge_logs: true,
    env: {
      NODE_ENV: "production",
    },
  }],
};
