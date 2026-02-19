# Local MCP Browser

为 AI 编程助手提供**本地浏览器操控能力**和**数据库操作能力**的 MCP 服务。基于 Playwright + Express + MCP SDK。

## 两个版本

| 版本 | 目录 | 适用 IDE | 传输协议 | 默认端口 |
|------|------|----------|----------|----------|
| **Cursor** | cursor/ | Cursor | Streamable HTTP | 3211 / 3212 |
| **Windsurf** | windsurf/ | Windsurf (Codeium) | Streamable HTTP | 3211 / 3212 |

> 两个版本功能完全一致，仅服务名称和 PM2 配置不同。浏览器和数据库服务共用统一管理脚本。

## 功能列表

### 浏览器 MCP（端口 3211）

| 工具 | 描述 |
|------|------|
| navigate | 跳转至指定网址 |
| click | 点击页面元素 |
| type | 输入文本 |
| take_screenshot | 截取页面截图 |
| set_viewport | 设置浏览器窗口大小 |
| get_console_logs | 获取控制台日志 |
| get_network | 获取网络请求 |
| execute_js | 执行 JavaScript |
| scroll | 页面滚动 |
| hover | 鼠标悬停 |
| fill_form | 批量填充表单 |
| get_page_content | 获取页面内容 |
| get_cookies / set_cookies | Cookie 操作 |
| go_back / go_forward | 浏览器前进后退 |
| wait_for_selector | 等待元素出现 |
| get_element_text | 获取元素文本 |
| get_element_attribute | 获取元素属性 |
| select_option | 下拉框选择 |
| pdf_export | 导出页面为 PDF |
| generate_page_report | 页面分析报告 |

### 数据库 MCP（端口 3212）

| 工具 | 描述 |
|------|------|
| connect | 连接 PostgreSQL / MySQL |
| disconnect | 断开连接 |
| status | 获取连接状态 |
| query | 执行 SQL 查询 (SELECT) |
| execute | 执行 SQL 操作 (INSERT/UPDATE/DELETE) |
| list_tables | 列出所有表 |
| describe_table | 获取表结构 |
| list_databases | 列出所有数据库 |
| list_presets | 列出预设数据库 |
| switch_db | 切换预设数据库 |

## 快速开始

```bash
# 1. 进入对应版本目录
cd cursor    # 或 cd windsurf

# 2. 安装依赖
npm install

# 3. 安装 Playwright 浏览器
npx playwright install chromium

# 4. 构建
npm run build

# 5. 安装数据库 MCP 依赖
cd mcp-database
npm install
npm run build
cd ..

# 6. 启动（PM2 守护模式）
npm install -g pm2
pm2 start ecosystem.config.cjs
cd mcp-database && pm2 start ecosystem.config.cjs

# 7. 验证
curl http://localhost:3211/health
curl http://localhost:3212/health
```

或者使用统一管理脚本（推荐）：

```bash
# 在根目录运行
manage.bat
# 选择版本 → 选择 [9.一键安装] → 选择 [1.启动全部]
```

## IDE 配置

### Cursor

编辑 `C:\Users\你的用户名\.cursor\mcp.json`：

```json
{
  "mcpServers": {
    "stable-browser": {
      "url": "http://localhost:3211/mcp"
    },
    "database": {
      "url": "http://localhost:3212/mcp"
    }
  }
}
```

### Windsurf

编辑 `C:\Users\你的用户名\.codeium\windsurf\mcp_config.json`：

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

配置后**重启 IDE**。

## 数据库配置

编辑对应版本目录下的 `mcp-database/.env`（参考 `.env.example`）：

| 变量 | 默认值 | 描述 |
|------|--------|------|
| DB_TYPE | postgresql | 数据库类型 (postgresql / mysql) |
| DB_HOST | localhost | 主机地址 |
| DB_PORT | 5432 | 端口号 |
| DB_NAME | mydb | 数据库名 |
| DB_USER | postgres | 用户名 |
| DB_PASSWORD | | 密码 |
| DB_SSL | false | 是否启用 SSL |
| PORT | 3212 | MCP 服务端口 |

支持预设多个数据库，通过别名快速切换（详见 `.env.example`）。

## 健壮性特性

* **端口冲突自动清理**: 启动时检测端口占用，自动杀掉旧进程
* **启动重试**: 端口绑定失败时自动重试 3 次（间隔递增）
* **浏览器崩溃自动恢复**: 检测到 Chromium 死亡时自动重建
* **PM2 守护**: 进程被 kill 后自动重启（3 秒延迟 + 指数退避）
* **全局异常捕获**: uncaughtException / unhandledRejection 不会导致服务崩溃
* **优雅退出**: SIGTERM/SIGINT 信号正确关闭浏览器
* **查询缓存**: SELECT 查询 60 秒 TTL 缓存，提升性能

## 统一管理脚本

根目录 `manage.bat` 提供统一管理入口：

* 选择 Cursor / Windsurf 版本
* 启动/停止/重启全部服务
* 查看状态和健康检查
* 查看日志
* 编辑数据库配置
* 显示 IDE 配置
* 一键安装

## 环境变量（浏览器 MCP）

| 变量 | 默认值 | 描述 |
|------|--------|------|
| PORT | 3211 | 服务端口 |
| HEADLESS | false | 无头模式 |
| VIEWPORT_WIDTH | 1920 | 浏览器宽度 |
| VIEWPORT_HEIGHT | 1080 | 浏览器高度 |
| DEVTOOLS | false | 自动打开 DevTools |
| SLOW_MO | 0 | 操作延迟（毫秒） |

## 系统要求

* Node.js >= 18
* Windows / macOS / Linux
* PM2（`npm install -g pm2`）
