module.exports = {
  apps: [{
    name: 'mcp-database-bridge',
    script: 'dist/server.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 500,
    env: {
      NODE_ENV: 'production',
      PORT: 3212
    }
  }]
};
