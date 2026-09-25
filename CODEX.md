# Codex CLI Setup

This project works with Codex CLI through standard MCP stdio transport. Codex can launch the browser MCP server directly from this repository, the same way Claude Code does.

> Database MCP was retired on 2026-09-25 — database access now goes through the baolei bastion MCP's `db_*` tools (see git history for the old setup).

## Install

From the repository root:

```bash
cd claude
node mcp.mjs install
```

This installs the browser dependencies, downloads the Patchright Chromium build, and builds the TypeScript output under `dist/`.

## Update

When the repository has new commits, upgrade everything with one command:

```bash
node claude/mcp.mjs update
```

It runs `git pull --ff-only`, reinstalls dependencies, verifies the Patchright Chromium binary, rebuilds the package, and restarts any running PM2 services. It aborts safely on a dirty working tree. stdio servers pick up the new build on the next session.

## Global Codex Registration

Codex reads MCP servers from:

```bash
~/.codex/config.toml
```

Recommended global config:

```toml
[mcp_servers.browser]
command = "node"
args = ['<仓库路径>/claude/bin/shim.mjs', 'headless']
type = "stdio"
cwd = "/ABSOLUTE/PATH/TO/localmcpbrower/claude"
startup_timeout_sec = 30
```

If Codex cannot find `node` because its shell environment has a minimal `PATH`, use an absolute Node path:

```toml
command = "/opt/homebrew/bin/node"
```

On macOS Homebrew installs, this is often `/opt/homebrew/bin/node` on Apple Silicon or `/usr/local/bin/node` on Intel.

## Optional Command Registration

You can also register servers with `codex mcp add`:

```bash
codex mcp add browser -- node  <仓库路径>/claude/bin/shim.mjs headless
```

## Verification

After editing `~/.codex/config.toml`, restart Codex or open a new session. MCP tools are loaded at session start.

Check registration:

```bash
codex mcp list
codex mcp get browser
```

Expected result:

- `browser` transport is `stdio`.

When loaded into a Codex session, the tool names should appear as:

- `mcp__browser__navigate`, `mcp__browser__click`, `mcp__browser__take_screenshot`, `mcp__browser__snapshot`, and the other browser tools.

## Usage Guidance For Codex

Prefer `mcp__browser__snapshot` before clicking unfamiliar pages. Prefer `mcp__browser__get_page_content` or extraction tools for text/data, and screenshots only for visual verification.

If MCP tools are configured but not visible in a session, restart Codex. If `codex mcp list` shows an HTTP URL like `localhost:3213`, switch back to the stdio config above.
