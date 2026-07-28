/**
 * 无头浏览器 MCP - PM2 配置
 * 适用于 Windows / macOS 后台运行和 Linux 服务器 / SSH 环境（HEADLESS=true）
 * 端口 3215，服务名 claudemcp-headless
 *
 * 文件名必须以 .config.cjs 结尾:
 *   PM2 只把 .json / .yml / .yaml / .config.js / .config.cjs / .config.mjs 当作 ecosystem 配置
 *   (pm2 lib/Common.js  knonwConfigFileExtensions)。文件叫 ecosystem.headless.cjs 时，
 *   `pm2 start ecosystem.headless.cjs` 会把它当**普通脚本**执行 —— 进程名变成
 *   "ecosystem.headless"、跑完立刻退出、被 autorestart 反复拉起最终 errored，
 *   而真正的 claudemcp-headless 根本没起来。改名前 `node mcp.mjs start` 就是这个下场。
 */
const path = require('path');

module.exports = {
  apps: [{
    name: 'claudemcp-headless',
    script: 'dist/server.js',
    cwd: __dirname,
    // 必须 fork，不能 cluster(写 instances 而不写 exec_mode 就会被 PM2 判成 cluster_mode)。
    // cluster 下监听 socket 是 PM2 God 守护进程持有的 —— 实测 3215 的 LISTENING owner
    // 就是 pm2/lib/Daemon.js。而 server.ts runHttp() 开头会 killPortProcess(PORT):
    // 它 netstat 找端口占用者然后 `taskkill /F /T`，于是会连同 PM2 守护进程整棵进程树一起杀，
    // 三个服务和 PM2 自己一起没。fork 模式下端口归 app 进程自己，不存在这个问题
    // (另外两个服务本来就是 fork，这里也对齐)。
    exec_mode: 'fork',
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
      PORT: '3215',
      // 原先是 0.0.0.0，等于把「已登录浏览器」的控制权开放给整个局域网。
      // 默认收回环回地址；跨机共享须显式改 HOST、设置 MCP_AUTH_TOKEN，
      // 并把客户端 URL 里的 host:port 写进 MCP_ALLOWED_HOSTS
      // (否则 SDK 的 DNS rebinding 校验会一律回 403 Invalid Host header)。
      HOST: '127.0.0.1',
      // 与有头服务(3213)并存时两者必须各占一份 profile:
      // 两个 Chromium 共用同一个 user_data 时磁盘上的 Cookies 互相覆盖，登录态会静默丢失。
      // 无头这边沿用默认的 storage/user_data，与 stdio 模式一致，老登录态无需迁移。
      USER_DATA_DIR: path.join(__dirname, 'storage', 'user_data'),
      HEADLESS: 'true',
      DEVTOOLS: 'false',
      SLOW_MO: '0',
    }
  }]
};
