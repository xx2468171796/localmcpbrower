# Codex Browser MCP Notes

## Purpose

This repo includes a Codex-usable browser MCP at `claudemcp/codexmcp-browser`.

It exists so future agents can immediately find a working browser MCP without re-implementing the Claude-side service.

## Location

- Service dir: `/opt/1panel/www/sites/5e.zygcbg.top/csgo0128/claudemcp/codexmcp-browser`
- Entry file: `/opt/1panel/www/sites/5e.zygcbg.top/csgo0128/claudemcp/codexmcp-browser/server.js`

## Start

```bash
cd /opt/1panel/www/sites/5e.zygcbg.top/csgo0128/claudemcp/codexmcp-browser
PORT=3215 node server.js
```

## Endpoints

- MCP: `http://127.0.0.1:3215/mcp`
- Health: `http://127.0.0.1:3215/health`
- Connections: `http://127.0.0.1:3215/connections`

## Rules

- Prefer this service when Codex needs browser automation for this repo.
- Do not modify the original `claudemcp` service unless the task explicitly requires it.
- This MCP reuses `claudemcp/dist/browser.js`, `claudemcp/dist/tools.js`, and `claudemcp/dist/schemas.js`.
- The original Claude MCP and this Codex MCP are intended to coexist.
- If browser tasks fail, check `/health` first, then restart `node server.js`.

## Verified

- `tools/list` works
- `navigate` works
- `get_page_content` works
