/**
 * 有头浏览器 MCP - PM2 配置
 * 可视化浏览器窗口，适合本地桌面 (Windows / macOS / Linux 桌面) 使用
 * 端口 3213，服务名 claudemcp-browser
 *
 * 注意: 有头模式必须跑在「已登录的交互桌面会话」里窗口才可见，
 *       所以只能用用户级自启 (启动文件夹 / 任务计划「只在用户登录时运行」/ pm2 startup)，
 *       绝不能注册成 Windows 系统服务 —— 那样进程落在 Session 0，窗口永远看不见。
 *       详见 DEPLOY.md「开机自启」。
 */
const path = require('path');

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
      // 浏览器里存着已登录的公司系统会话，端口暴露 = 会话控制权暴露。
      // 只绑回环是底线；跨机共享必须显式改 HOST 并同时设置 MCP_AUTH_TOKEN。
      HOST: '127.0.0.1',
      // 有头与无头是两个并存的进程，各自要开一个 Chromium。
      // browser.ts 的默认 userDataDir 对两者解析出的是同一个 storage/user_data ——
      // 两个 Chromium 共用一份 profile 时，磁盘上的 Cookies 由最后落盘的那个覆盖，
      // 实测两边写入的登录态都会丢。所以这里必须显式分开：有头独占 user_data_headed，
      // 无头沿用 user_data（与 stdio 默认值一致，老登录态不迁移）。
      // 代价：有头 / 无头是两份独立登录态，要共用就只跑其中一个。
      USER_DATA_DIR: path.join(__dirname, 'storage', 'user_data_headed'),
      HEADLESS: 'false',
      DEVTOOLS: 'false'
    }
  }]
};
