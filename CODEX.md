# Codex CLI Setup

This project works with Codex CLI through standard MCP stdio transport. Codex can launch the browser and database MCP servers directly from this repository, the same way Claude Code does.

## Install

From the repository root:

```bash
cd claude
node mcp.mjs install
```

This installs browser/database dependencies, downloads Chromium, and builds the TypeScript output under `dist/`.

## Global Codex Registration

Codex reads MCP servers from:

```bash
~/.codex/config.toml
```

Recommended global config:

```toml
[mcp_servers.browser]
command = "node"
args = ["/ABSOLUTE/PATH/TO/localmcpbrower/claude/dist/server.js", "--stdio"]
type = "stdio"
cwd = "/ABSOLUTE/PATH/TO/localmcpbrower/claude"
startup_timeout_sec = 30

[mcp_servers.database]
command = "node"
args = ["/ABSOLUTE/PATH/TO/localmcpbrower/claude/mcp-database/dist/server.js", "--stdio"]
type = "stdio"
cwd = "/ABSOLUTE/PATH/TO/localmcpbrower/claude/mcp-database"
startup_timeout_sec = 30

[mcp_servers.database.env]
MCP_TRANSPORT = "stdio"
```

If Codex cannot find `node` because its shell environment has a minimal `PATH`, use an absolute Node path:

```toml
command = "/opt/homebrew/bin/node"
```

On macOS Homebrew installs, this is often `/opt/homebrew/bin/node` on Apple Silicon or `/usr/local/bin/node` on Intel.

## Optional Command Registration

You can also register servers with `codex mcp add`:

```bash
codex mcp add browser -- node /ABSOLUTE/PATH/TO/localmcpbrower/claude/dist/server.js --stdio
codex mcp add database --env MCP_TRANSPORT=stdio -- node /ABSOLUTE/PATH/TO/localmcpbrower/claude/mcp-database/dist/server.js --stdio
```

If your Codex version supports `cwd` only through config files, prefer editing `~/.codex/config.toml` so the database server reliably reads `claude/mcp-database/.env`.

## Database Configuration

Database credentials live in:

```bash
claude/mcp-database/.env
```

Create it from the example:

```bash
cp claude/mcp-database/.env.example claude/mcp-database/.env
```

Codex should never print passwords or full secret-bearing connection strings. Use the database MCP tools for read-only inspection unless the user explicitly requests a mutation.

## Verification

After editing `~/.codex/config.toml`, restart Codex or open a new session. MCP tools are loaded at session start.

Check registration:

```bash
codex mcp list
codex mcp get browser
codex mcp get database
```

Expected result:

- `browser` transport is `stdio`.
- `database` transport is `stdio`.
- `database` has `MCP_TRANSPORT=stdio`.
- `database` has `cwd` set to `.../claude/mcp-database`.

When loaded into a Codex session, the tool names should appear as:

- `mcp__browser__navigate`, `mcp__browser__click`, `mcp__browser__take_screenshot`, `mcp__browser__snapshot`, and the other browser tools.
- `mcp__database__status`, `mcp__database__query`, `mcp__database__list_tables`, `mcp__database__describe_table`, and the other database tools.

## Usage Guidance For Codex

Prefer `mcp__browser__snapshot` before clicking unfamiliar pages. Prefer `mcp__browser__get_page_content` or extraction tools for text/data, and screenshots only for visual verification.

Prefer `mcp__database__status`, `list_tables`, `describe_table`, and `query` for read-only work. Explain and confirm destructive SQL unless the user has clearly requested that exact change.

If MCP tools are configured but not visible in a session, restart Codex. If `codex mcp list` shows HTTP URLs like `localhost:3213` or `localhost:3214`, switch back to the stdio config above.
