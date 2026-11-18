# Development notes (moved verbatim from AGENTS.md, 2026-11-19)

## Current shape

- **MCP SDK v2** only. Server speaks old and new protocol versions; in practice clients use `2025-11-25` (no probing over stdio).
- Two resident PM2 services: `claudemcp-headless` 3215 / `claudemcp-browser` (headed, compat) 3213.
- Clients connect over stdio via **`bin/shim.mjs`** (or the launcher `~/.ankotti/browser-mcp/shim.mjs`), which forwards bytes to the service's named pipe / unix socket. **One socket = one client window.**
- 57 tools (3.0 added cdp_send, fill_secret, login_with_asset, run_flow, recording ×3, browser_tabs / downloads / block_rules).
- **On-demand window** (2.3.0): headless by default; `wait_for_human` / `request_human` switch the workspace to a visible window in place (same profile, cookies / tab URLs carried over); `hide_window` returns. `BrowserManager.switchMode`, test `npm run test:headed`.

## Session semantics

| | Behaviour | Switch |
|---|---|---|
| **Login state / cookies** | **Always shared** | — |
| **Tabs** | **Shared by default** — any window can take over another's page | `PIPE_ISOLATED=1` isolates |

## Client registration

`node claude/mcp.mjs config` prints the registration commands for this machine (absolute paths). In Codex `~/.codex/config.toml`, Windows paths **must be TOML literal strings (single quotes)**: in `"D:\nodejs\node.exe"` the `\n` becomes a newline.

## Must know before changing code

1. **`page.evaluate` runs in an isolated world.** Check whether an injected script ran **through the DOM** (shared across worlds); reading main-world `window.X` from `page.evaluate` reports "not run".
2. **Page scripts are installed per page over CDP only** (`Page.enable`, then `Page.addScriptToEvaluateOnNewDocument`, see `browser.ts preparePage`). `context.addInitScript` runs under patchright 1.63 but **breaks cross-site iframes** (chrome-error). Never go back to "route intercepts HTML and injects `<script>`": the document is then fetched by Node and sites see Node's TLS fingerprint. Don't add fingerprint spoofing; run `node claude/test/stealth-check.mjs` first (anti-detection: `docs/architecture.md` §12).
3. **Don't set the pipe leg's `legacy` to `'reject'`** — stdio clients don't probe the new protocol; nothing would connect.
4. **Shared session ids carry a generation** — `BrowserManager` leaves tombstones on reclaim; a fixed id means "never connects again after the last window closes".
5. **v2 error "`ZodObject` not assignable to `ZodRawShape`"**: check `outputSchema` first — the error points the wrong way.

More pitfalls: `MCP-V2-PLAN.md` §3.

## Updating the local MCP

Staff PCs update themselves (local host / ai-kit switch to the release-center version when the browser is idle; `node ~/.ankotti/ai-kit/browser-mcp.mjs status` shows the running version and manager). Only on a **git-installed dev machine**, when the user says "更新本地 MCP": `node claude/mcp.mjs update` (git pull --ff-only, reinstall deps, check Chromium, rebuild `dist/`, restart running PM2 services; aborts on uncommitted changes). Then tell the user (in Chinese) to `/mcp` reconnect in Claude Code or restart Codex. Upgrading **v1 → v2** needs `rm -rf node_modules package-lock.json` first (see `UPDATE-PROMPT.md`).
