# process-guard Spec

## 概述
进程守护与监控，确保服务高可用。

## PM2 配置

```javascript
// ecosystem.config.js
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
      PORT: 3000
    }
  }]
};
```

## 行为规范

1. **自动重启**: 进程崩溃后 500ms 内自动重启
2. **日志管理**: PM2 自动管理日志轮转
3. **优雅退出**: 收到 SIGTERM 时先关闭浏览器再退出

## 监控指标

- 进程存活状态
- 内存使用量
- 重启次数
- 浏览器连接状态

## 依赖
- pm2 (全局安装)
