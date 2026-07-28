/**
 * 数据库 MCP - PM2 配置
 * 端口 3214，服务名 claudemcp-database
 *
 * 常驻后所有客户端共用一套连接池（不再是每个 stdio 进程各起一套），
 * 但每个会话的「当前库指针」相互独立，A 窗口 switch_db 不会把 B 窗口带到别的库。
 */
module.exports = {
  apps: [{
    name: 'claudemcp-database',
    script: 'dist/server.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 500,
    max_memory_restart: '512M',
    error_file: 'logs/database-error.log',
    out_file: 'logs/database-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    env: {
      NODE_ENV: 'production',
      PORT: '3214',
      // 数据库端点等于一条到生产库的通道，默认只绑回环；跨机共享要三件事一起做:
      //   1) HOST 改成 0.0.0.0(或具体网卡地址)
      //   2) 设置 MCP_AUTH_TOKEN，客户端带 Authorization: Bearer <token>
      //   3) MCP_ALLOWED_HOSTS 填客户端 URL 里实际用的 host:port(逗号分隔可多个)——
      //      SDK 对 Host 头做全等匹配，缺这一条远端一律 403 Invalid Host header。
      //      注意 HOST=0.0.0.0 不会被自动放行(buildAllowedHosts 显式排除)。
      HOST: '127.0.0.1'
    }
  }]
};
