# MCP Bridge 服务套件

为 AI 助手提供**浏览器操作**和**数据库操作**能力的 MCP 服务套件。

---

## 服务概览

| 服务 | 端口 | 功能 |
|------|------|------|
| **浏览器 MCP** | 3211 | 网页导航、点击、截图、JS执行等 |
| **数据库 MCP** | 3212 | PostgreSQL/MySQL 查询、表管理等 |

---

## 一、快速开始

### 1. 一键安装（推荐）

**双击 `install-all.bat`** - 自动安装全部组件

包含：
- ✅ Node.js 版本检查
- ✅ PM2 进程管理器
- ✅ 浏览器 MCP 依赖
- ✅ **Playwright Chromium 内核**（~150MB）
- ✅ 数据库 MCP 依赖
- ✅ 项目构建

**分别安装：**
```bash
# 仅安装浏览器 MCP（含 Playwright）
install.bat

# 仅安装数据库 MCP
cd mcp-database && install.bat
```

### 2. 配置数据库（可选）

编辑 `mcp-database/.env` 填写数据库信息：

```ini
DB_TYPE=postgresql
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mydb
DB_USER=postgres
DB_PASSWORD=your_password
```

### 3. 一键启动全部服务

```bash
mcp-all-manage.bat
# 选择 1 启动全部服务
```

### 4. 配置 Windsurf/Cursor

将以下配置添加到 MCP 配置文件：

**Windsurf**: `C:\Users\用户名\.codeium\windsurf\mcp_config.json`
**Cursor**: `C:\Users\用户名\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "stable-browser": {
      "serverUrl": "http://localhost:3211/mcp"
    },
    "database": {
      "serverUrl": "http://localhost:3212/mcp"
    }
  }
}
```

**重启 IDE 后即可使用！**

---

## 二、浏览器 MCP 工具

| 工具 | 描述 |
|------|------|
| `navigate` | 跳转至指定网址 |
| `click` | 点击页面元素 |
| `type` | 输入文本 |
| `take_screenshot` | 截取页面截图 |
| `get_console_logs` | 获取控制台日志 |
| `get_network` | 获取网络请求 |
| `execute_js` | 执行 JavaScript |
| `scroll` | 页面滚动 |
| `hover` | 鼠标悬停 |
| `fill_form` | 批量填充表单 |
| `get_page_content` | 获取页面内容 |
| `get_cookies` | 获取 Cookie |
| `set_cookies` | 设置 Cookie |

---

## 三、数据库 MCP 工具

| 工具 | 描述 |
|------|------|
| `connect` | 连接数据库（PostgreSQL/MySQL） |
| `disconnect` | 断开连接 |
| `status` | 查看连接状态 |
| `query` | 执行 SELECT 查询 |
| `execute` | 执行 INSERT/UPDATE/DELETE |
| `list_tables` | 列出所有表 |
| `describe_table` | 获取表结构 |
| `list_databases` | 列出所有数据库 |
| `list_presets` | 列出预设数据库 |
| `switch_db` | 切换预设数据库 |

### 数据库使用示例

```
# 连接 PostgreSQL
connect({ type: "postgresql", host: "localhost", port: 5432, database: "mydb", user: "postgres", password: "xxx" })

# 查询数据
query({ sql: "SELECT * FROM users LIMIT 10" })

# 列出表
list_tables({})

# 查看表结构
describe_table({ table: "users" })
```

### 多数据库配置

在 `.env` 中配置多个数据库，通过别名快速切换：

```ini
# 生产环境
DB_PROD_TYPE=postgresql
DB_PROD_HOST=prod.example.com
DB_PROD_PORT=5432
DB_PROD_NAME=production
DB_PROD_USER=admin
DB_PROD_PASSWORD=secret

# 测试环境
DB_TEST_TYPE=mysql
DB_TEST_HOST=test.example.com
DB_TEST_PORT=3306
DB_TEST_NAME=testdb
DB_TEST_USER=tester
DB_TEST_PASSWORD=test123
```

使用 `switch_db({ alias: "PROD" })` 切换数据库。

---

## 四、服务管理

### 统一管理（推荐）

```bash
mcp-all-manage.bat
```

菜单选项：
- 1: 启动全部服务
- 2: 停止全部服务
- 3: 重启全部服务
- 4: 查看状态
- 5: 管理浏览器 MCP
- 6: 管理数据库 MCP

### 单独管理

```bash
# 浏览器 MCP
manage.bat

# 数据库 MCP
cd mcp-database && manage.bat
```

### PM2 命令

```bash
pm2 status                    # 查看状态
pm2 restart all               # 重启全部
pm2 logs                      # 查看日志
pm2 logs windsurf-mcp-bridge  # 浏览器日志
pm2 logs mcp-database-bridge  # 数据库日志
```

---

## 五、目录结构

```
mcp-bridge/
├── src/                      # 浏览器 MCP 源码
├── dist/                     # 浏览器 MCP 编译后代码
├── mcp-database/             # 数据库 MCP
│   ├── src/                  # 数据库 MCP 源码
│   ├── dist/                 # 数据库 MCP 编译后代码
│   ├── .env.example          # 数据库配置模板
│   └── manage.bat            # 数据库服务管理
├── storage/                  # 浏览器数据存储
├── install.bat               # 浏览器 MCP 安装
├── manage.bat                # 浏览器服务管理
├── mcp-all-manage.bat        # 统一服务管理
└── ecosystem.config.cjs      # PM2 配置
```

---

## 六、环境变量

### 浏览器 MCP (.env)

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `PORT` | 3211 | 服务端口 |
| `HEADLESS` | false | 无头模式 |
| `VIEWPORT_WIDTH` | 1920 | 浏览器宽度 |
| `VIEWPORT_HEIGHT` | 1080 | 浏览器高度 |

### 数据库 MCP (mcp-database/.env)

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `PORT` | 3212 | 服务端口 |
| `DB_TYPE` | - | 数据库类型 (postgresql/mysql) |
| `DB_HOST` | - | 主机地址 |
| `DB_PORT` | - | 端口号 |
| `DB_NAME` | - | 数据库名 |
| `DB_USER` | - | 用户名 |
| `DB_PASSWORD` | - | 密码 |

---

## 七、故障排查

### 🔍 一键诊断

**双击 `diagnose.bat`** - 自动检测所有问题

诊断项目：
- ✅ Node.js 版本
- ✅ PM2 安装状态
- ✅ 依赖完整性
- ✅ 项目构建状态
- ✅ Playwright Chromium
- ✅ 端口占用情况
- ✅ 防火墙配置
- ✅ 服务运行状态

### 移植到新电脑连不上？

**常见原因：**

1. **Playwright 未安装**（最常见）
   ```bash
   npx playwright install chromium
   ```

2. **端口被占用**
   ```bash
   # 检查端口
   netstat -ano | findstr "3211"
   # 杀死进程
   taskkill /PID <进程ID> /F
   ```

3. **防火墙拦截**
   - 允许 Node.js 通过 Windows 防火墙
   - 或临时关闭防火墙测试

4. **依赖未安装**
   ```bash
   npm install
   npm run build
   ```

5. **PM2 未安装**
   ```bash
   npm install -g pm2
   ```

### 常见问题

**Q: 端口被占用怎么办？**
修改 `.env` 中的 `PORT` 变量，然后重启服务。

**Q: 数据库连接失败？**
1. 检查数据库服务是否运行
2. 检查防火墙是否允许端口
3. 检查用户名密码是否正确

**Q: 浏览器没有打开？**
运行 `npx playwright install chromium` 安装 Chromium 内核。

**Q: 如何查看服务日志？**
```bash
pm2 logs --lines 100
```

**Q: 服务启动后立即停止？**
查看日志找到错误原因：`pm2 logs windsurf-mcp-bridge --lines 50`
