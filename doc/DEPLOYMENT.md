# MCP Browser Bridge 部署指南

## 目录
- [Windows 全新环境配置](#windows-全新环境配置)
- [本地部署](#本地部署)
- [远程服务器部署](#远程服务器部署)
- [远程连接配置](#远程连接配置)
- [常见问题](#常见问题)

---

## Windows 全新环境配置

### 第一步：安装 Node.js

1. 访问 https://nodejs.org/
2. 下载 **LTS 版本**（推荐 18.x 或 20.x）
3. 运行安装程序，**全部默认下一步**
4. 安装完成后，打开 **PowerShell** 或 **命令提示符**，验证安装：

```powershell
node -v    # 应显示 v18.x.x 或更高
npm -v     # 应显示 9.x.x 或更高
```

### 第二步：安装 Git（可选，用于克隆项目）

1. 访问 https://git-scm.com/download/win
2. 下载并安装，**全部默认下一步**
3. 验证安装：

```powershell
git --version
```

### 第三步：下载项目

**方式一：Git 克隆**
```powershell
git clone <your-repo-url>
cd MCPliulanqi
```

**方式二：直接下载 ZIP**
1. 从仓库页面下载 ZIP 文件
2. 解压到任意目录（如 `D:\MCPliulanqi`）
3. 打开 PowerShell，进入目录：
```powershell
cd D:\MCPliulanqi
```

### 第四步：安装项目依赖

```powershell
npm install
```

### 第五步：安装浏览器

```powershell
npx playwright install chromium
```

### 第六步：构建项目

```powershell
npm run build
```

### 第七步：启动服务

**方式一：前台运行（调试用）**
```powershell
npm start
```

**方式二：PM2 后台运行（推荐）**
```powershell
# 全局安装 PM2
npm install -g pm2

# 启动服务
pm2 start ecosystem.config.cjs

# 设置开机自启（需要管理员权限）
pm2 save
pm2-startup install
```

### 第八步：配置 Windsurf/Cursor

1. 打开 Windsurf 或 Cursor
2. 找到 MCP 配置文件位置：
   - Windsurf: `C:\Users\你的用户名\.codeium\windsurf\mcp_config.json`
   - Cursor: `C:\Users\你的用户名\.cursor\mcp.json`
3. 添加以下配置：

```json
{
  "mcpServers": {
    "stable-browser": {
      "type": "sse",
      "url": "http://localhost:3210/sse"
    }
  }
}
```

4. 重启 IDE 或刷新 MCP 连接

### 第九步：验证安装

1. 运行 `manage.bat`（双击）
2. 选择 **4. Status** 查看服务状态
3. 在 IDE 中测试 MCP 工具

### 快速命令总结

```powershell
# 一键安装（在项目目录执行）
npm install
npx playwright install chromium
npm run build

# 启动
npm install -g pm2
pm2 start ecosystem.config.cjs

# 管理
.\manage.bat
```

---

## 本地部署

### 环境要求
- Node.js 18+
- Windows / macOS / Linux

### 安装步骤

```bash
# 1. 克隆项目
git clone <your-repo-url>
cd MCPliulanqi

# 2. 安装依赖
npm install

# 3. 安装浏览器
npx playwright install chromium

# 4. 构建项目
npm run build

# 5. 启动服务
npm start
# 或使用 PM2 后台运行
npm install -g pm2
pm2 start ecosystem.config.cjs
```

### 配置 Windsurf/Cursor

在 MCP 配置文件中添加：

```json
{
  "mcpServers": {
    "stable-browser": {
      "type": "sse",
      "url": "http://localhost:3210/sse"
    }
  }
}
```

### 使用管理脚本

双击运行 `manage.bat`（Windows）：
- **1. Start** - 后台启动服务
- **2. Stop** - 停止服务
- **3. Restart** - 重启服务
- **4. Status** - 实时监控连接状态
- **5. Config** - 查看配置和本地IP
- **6. Logs** - 查看日志
- **7. Connection Check** - 检查连接状态

---

## 远程服务器部署

### Debian/Ubuntu 服务器

```bash
# 1. 更新系统
apt update && apt upgrade -y

# 2. 安装 Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

# 3. 安装 Git
apt install -y git

# 4. 克隆项目
git clone <your-repo-url>
cd MCPliulanqi

# 5. 安装依赖
npm install

# 6. 安装 Playwright 浏览器和系统依赖
npx playwright install chromium
npx playwright install-deps chromium

# 如果上面命令报错，手动安装依赖：
apt install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libatspi2.0-0

# 7. 构建项目
npm run build

# 8. 安装 PM2 并启动
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup  # 设置开机自启
```

### CentOS/RHEL 服务器

```bash
# 1. 安装 Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# 2. 安装依赖
yum install -y git

# 3. 后续步骤同上
```

---

## 远程连接配置

### 方案一：SSH 反向隧道（推荐）

在**本地 Windows** 执行：

```bash
ssh -R 3210:localhost:3210 user@your-vps-ip
```

VPS 上的 MCP 配置使用 `localhost:3210`：

```json
{
  "mcpServers": {
    "stable-browser": {
      "type": "sse",
      "url": "http://localhost:3210/sse"
    }
  }
}
```

### 方案二：直接暴露端口

1. 在 VPS 上启动 MCP Bridge
2. 配置防火墙允许 3210 端口
3. 本地 MCP 配置：

```json
{
  "mcpServers": {
    "stable-browser": {
      "type": "sse",
      "url": "http://YOUR_VPS_IP:3210/sse"
    }
  }
}
```

### 方案三：Nginx 反向代理

```nginx
# /etc/nginx/sites-available/mcp-bridge
server {
    listen 80;
    server_name mcp.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3210;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_cache off;
    }
}
```

---

## 功能端点

| 端点 | 说明 |
|------|------|
| `http://localhost:3210/sse` | MCP SSE 连接端点 |
| `http://localhost:3210/health` | 健康检查 |
| `http://localhost:3210/connections` | 查看活跃连接 |
| `http://localhost:3210/report` | 页面分析报告 |

---

## 可用工具列表

### 导航类
- `navigate` - 跳转至指定网址
- `go_back` - 浏览器后退
- `go_forward` - 浏览器前进
- `scroll` - 页面滚动

### 元素操作
- `click` - 点击元素
- `type` - 输入文本
- `hover` - 鼠标悬停
- `wait_for_selector` - 等待元素出现
- `get_element_text` - 获取元素文本
- `get_element_attribute` - 获取元素属性

### 表单操作
- `select_option` - 选择下拉框
- `fill_form` - 批量填充表单

### 页面内容
- `get_page_content` - 获取页面HTML/文本
- `take_screenshot` - 截图
- `pdf_export` - 导出PDF
- `execute_js` - 执行JavaScript

### Cookie 管理
- `get_cookies` - 获取Cookie
- `set_cookies` - 设置Cookie

### 调试工具
- `get_console_logs` - 获取控制台日志
- `get_network` - 获取网络请求

### 报告工具
- `generate_page_report` - 生成页面分析报告

---

## 常见问题

### Q: browserAlive: false
**原因**：浏览器未启动或崩溃

**解决**：
```bash
# 重装浏览器
npx playwright install chromium
npx playwright install-deps chromium

# 重启服务
pm2 restart windsurf-mcp-bridge
```

### Q: No transport found for sessionId
**原因**：服务重启后旧连接失效

**解决**：在 IDE 中刷新 MCP 连接

### Q: 远程服务器无法启动浏览器
**原因**：缺少系统依赖

**解决**：
```bash
npx playwright install-deps chromium
```

### Q: 连接超时 / connection refused
**原因**：防火墙阻止或端口未开放

**解决**：
```bash
# UFW
ufw allow 3210

# firewalld
firewall-cmd --add-port=3210/tcp --permanent
firewall-cmd --reload
```

### Q: 远程连接中断 / 连接不稳定
**原因**：网络不稳定或服务重启导致SSE连接断开

**解决方案**：

1. **使用SSH隧道保持稳定连接**（推荐）：
```bash
# 本地Windows执行，保持终端开启
ssh -R 3210:localhost:3210 user@vps-ip
```

2. **客户端自动重连**：MCP客户端会自动尝试重连，如果失败需要手动刷新MCP连接

3. **服务端保活**：确保PM2配置了自动重启
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

4. **Nginx配置超时**（如果使用Nginx反向代理）：
```nginx
proxy_connect_timeout 86400s;
proxy_send_timeout 86400s;
proxy_read_timeout 86400s;
```

---

## 日志查看

```bash
# PM2 日志
pm2 logs windsurf-mcp-bridge

# 实时日志
pm2 logs windsurf-mcp-bridge --lines 100
```

---

## 更新升级

```bash
cd MCPliulanqi
git pull
npm install
npm run build
pm2 restart windsurf-mcp-bridge
```
