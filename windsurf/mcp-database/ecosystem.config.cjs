module.exports = {
  apps: [{
    name: 'windsurf-mcp-database',
    script: 'dist/server.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 50,
    restart_delay: 3000,
    min_uptime: 5000,
    kill_timeout: 5000,
    exp_backoff_restart_delay: 1000,
    env: {
      NODE_ENV: 'production',
      PORT: 3212
    }
  }]
};
