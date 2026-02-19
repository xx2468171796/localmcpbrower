# Windsurf MCP Bridge

为 Windsurf 提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。

## 快速开始

```bash
# 方法一：一键安装
install-all.bat

# 方法二：手动安装
npm install
npx playwright install chromium
npm run build
cd mcp-database && npm install && npm run build && cd ..

# 启动服务
manage.bat    # 选择 [1.启动全部]
```

## Windsurf 配置

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

## 浏览器工具（端口 3211）

navigate / click / type / take_screenshot / set_viewport / get_console_logs / get_network / execute_js / scroll / hover / fill_form / get_page_content / get_cookies / set_cookies / go_back / go_forward / wait_for_selector / get_element_text / get_element_attribute / select_option / pdf_export / generate_page_report

## 数据库工具（端口 3212）

connect / disconnect / status / query / execute / list_tables / describe_table / list_databases / list_presets / switch_db

## 数据库配置

编辑 `mcp-database/.env`（参考 `.env.example`），配置 PostgreSQL 或 MySQL 连接信息。

## 管理脚本

- `manage.bat` — 启动/停止/重启/日志/状态/安装
- `install-all.bat` — 一键安装全部依赖
- `diagnose.bat` — 诊断工具

## 系统要求

- Node.js >= 18
- PM2（`npm install -g pm2`）
