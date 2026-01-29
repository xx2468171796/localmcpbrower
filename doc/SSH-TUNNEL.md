# SSH 隧道连接指南

## 为什么需要SSH隧道？

SSE连接在跨网络环境下容易被NAT/防火墙断开。SSH隧道可以：
- 把远程连接变成"本地连接"
- 自带心跳和重连机制
- 加密传输更安全

## 网络架构

```
┌─────────────────┐                    ┌─────────────────┐
│  Windows 本机    │                    │  Debian 远程     │
│  192.168.10.213 │ ← SSH隧道 ←────────│  192.168.110.253 │
│                 │                    │                 │
│  MCP服务:3211   │                    │  IDE(Windsurf)  │
│  (实际运行)     │                    │  (需要连接MCP)  │
└─────────────────┘                    └─────────────────┘
```

## 方案一：从Windows建立隧道（推荐）

### 步骤1：在Windows上运行隧道脚本

双击运行 `ssh-tunnel.bat`，或在CMD中执行：

```cmd
ssh -R 3211:localhost:3211 root@192.168.110.253 -N -o ServerAliveInterval=30
```

参数说明：
- `-R 3211:localhost:3211` = 把本地3211端口映射到远程的localhost:3211
- `-N` = 只建立隧道，不执行命令
- `-o ServerAliveInterval=30` = 每30秒发送心跳

### 步骤2：修改Debian上的MCP配置

```json
{
  "mcpServers": {
    "stable-browser": {
      "type": "sse",
      "url": "http://localhost:3211/sse"
    }
  }
}
```

### 步骤3：在Debian的IDE中刷新MCP连接

---

## 方案二：从Debian建立隧道

如果Windows没有SSH客户端，可以从Debian发起连接：

### 步骤1：在Debian上执行

```bash
ssh -L 3211:localhost:3211 Administrator@192.168.10.213 -N
```

这会把Windows的3211端口映射到Debian本地的3211。

### 步骤2：MCP配置同上

```json
{
  "url": "http://localhost:3211/sse"
}
```

---

## 常见问题

### Q: SSH连接不上Debian？

1. 检查Debian的SSH服务：
   ```bash
   systemctl status sshd
   ```

2. 检查防火墙：
   ```bash
   ufw status
   # 或
   iptables -L
   ```

3. 检查SSH配置允许端口转发：
   ```bash
   grep -i AllowTcpForwarding /etc/ssh/sshd_config
   # 应该是 yes
   ```

### Q: 隧道断开怎么办？

使用 `ssh-tunnel.bat` 脚本，它会自动重连。

或手动添加重连逻辑：
```bash
while true; do
  ssh -R 3211:localhost:3211 root@debian -N
  echo "断开，5秒后重连..."
  sleep 5
done
```

### Q: Windows没有SSH？

1. Windows 10/11 自带 OpenSSH，在 PowerShell 中可直接使用 `ssh` 命令
2. 或安装 Git Bash，自带 SSH
3. 或安装 PuTTY (使用 plink 命令)

---

## 验证隧道是否工作

在Debian上执行：
```bash
curl http://localhost:3211/health
```

应该返回：
```json
{"status":"ok","browserAlive":true,...}
```
