# Codex Instructions

## Purpose

This repository provides local MCP servers for browser automation and database access. When Codex works in this repo, keep the project usable by both Claude Code and Codex CLI.

## Preferred MCP Usage

When these tools are visible in the current Codex session, use them directly:

- `mcp__browser__*` for local browser automation, screenshots, scraping, cookies, network/console inspection, PDF export, accessibility snapshots, and QA workflows.
- `mcp__database__*` for PostgreSQL/MySQL connection checks, schema inspection, SQL queries, explain plans, indexes, relations, stats, database switching, and CSV export.
- `mcp__context7__*` for current library/framework documentation.
- `mcp__memory__*` only when the user explicitly asks to remember or retrieve durable context.

If `mcp__browser__*` or `mcp__database__*` are not visible, first check the global Codex MCP configuration with:

```bash
codex mcp list
codex mcp get browser
codex mcp get database
```

Codex loads MCP tools when a session starts, so after config changes the user may need to restart Codex or open a new session.

## Codex Setup Canonical Docs

Use `CODEX.md` as the Codex-specific setup and troubleshooting guide.

For global Codex registration, prefer stdio mode:

```toml
[mcp_servers.browser]
command = "<absolute-node-path-or-node>"
args = ["<absolute-path>/claude/dist/server.js", "--stdio"]
type = "stdio"
cwd = "<absolute-path>/claude"
startup_timeout_sec = 30

[mcp_servers.database]
command = "<absolute-node-path-or-node>"
args = ["<absolute-path>/claude/mcp-database/dist/server.js", "--stdio"]
type = "stdio"
cwd = "<absolute-path>/claude/mcp-database"
startup_timeout_sec = 30

[mcp_servers.database.env]
MCP_TRANSPORT = "stdio"
```

Use an absolute Node path when the Codex shell environment does not include `node` in `PATH`.

## Development Rules

- Keep stdio mode first-class. It should not require PM2 or ports.
- Keep HTTP/PM2 mode working as an optional long-running deployment path.
- Do not commit local `.env` files or secrets.
- When changing tool behavior, update `USAGE.md`.
- When changing install/config behavior, update `DEPLOY.md`, `claude/README.md`, and `CODEX.md` if applicable.
- After TypeScript changes, run the relevant build command under `claude/`.

## Updating the Local MCP Servers

When the user asks to update the local MCP browser/database servers (e.g. "更新本地 MCP" / "update the local MCP servers"), run:

```bash
node claude/mcp.mjs update
```

This pulls the latest repo changes (`git pull --ff-only`), reinstalls dependencies in both packages, verifies the Patchright Chromium binary, rebuilds `dist/`, and restarts any running PM2 services. It aborts safely if the working tree has uncommitted changes — ask the user to commit or stash first. stdio-mode servers pick up the new build on the next session (or after `/mcp` reconnect in Claude Code).
