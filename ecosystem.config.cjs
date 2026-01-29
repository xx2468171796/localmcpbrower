module.exports = {
  apps: [{
    name: 'windsurf-mcp-bridge',
    script: 'dist/server.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 500,
    env: {
      NODE_ENV: 'production',
      PORT: 3210,
      HEADLESS: 'false',
      DEVTOOLS: 'true'
    }
  }]
};
