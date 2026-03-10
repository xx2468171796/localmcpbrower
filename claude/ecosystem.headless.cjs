/**
 * 无头浏览器 MCP - PM2 配置
 * 适用于 macOS 调试（HEADLESS=true）和 Debian 13 服务器
 * 端口 3215，服务名 claudemcp-headless
 */
module.exports = {
  apps: [{
    name: 'claudemcp-headless',
    script: 'dist/server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 50,
    restart_delay: 3000,
    min_uptime: 5000,
    kill_timeout: 5000,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: '512M',
    error_file: 'logs/headless-error.log',
    out_file: 'logs/headless-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
      PORT: '3211',
      HOST: '0.0.0.0',
      HEADLESS: 'true',
      DEVTOOLS: 'false',
      SLOW_MO: '0',
    }
  }]
};
