/**
 * 有头浏览器 MCP - PM2 配置
 * 可视化浏览器窗口，适合本地桌面 (macOS / Windows) 调试
 * 端口 3213，服务名 claudemcp-browser
 */
module.exports = {
  apps: [{
    name: 'claudemcp-browser',
    script: 'dist/server.js',
    cwd: __dirname,
    watch: false,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 3000,
    min_uptime: 5000,
    kill_timeout: 5000,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: '512M',
    error_file: 'logs/browser-error.log',
    out_file: 'logs/browser-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
      PORT: '3213',
      HEADLESS: 'false',
      DEVTOOLS: 'false'
    }
  }]
};
