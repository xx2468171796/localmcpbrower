module.exports = {
  apps: [{
    name: 'claudemcp-database',
    script: 'dist/server.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 500,
    env: {
      NODE_ENV: 'production',
      PORT: 3214
    }
  }]
};
