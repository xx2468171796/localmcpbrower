# AI guide (Claude Code / Codex)

This repo is a local MCP server: **browser control**. (The database MCP was retired 2026-09-25; use the baolei bastion's `db_*` tools.)

This file is an **index**. Don't read all docs (100 KB+); open only the one you need. Reply to the user in Chinese; AI-only docs here are in English.

| Task | Read |
|---|---|
| **Start here**: current state, red lines, routing (one screen) | **`.ankotti/MEMORY.md`** |
| **Before changing code**: direction, module boundaries, AI desk phases | **`docs/architecture.md`** (update it first for a new domain or boundary change) |
| **Release** (pack, upload, register; local-host and ai-kit update channels) | **`docs/memory/release.md`** (scripts `claude/scripts/pack-release.mjs`, `register-release.mjs`) |
| How staff PCs get new versions | Automatic: bastion local host (default channel), ai-kit as fallback — see `docs/memory/release.md` |
| Manual install / upgrade on another machine (developers, machines without the bastion) | **`UPDATE-PROMPT.md`** — paste it whole to that machine's AI |
| Deploy step by step + troubleshooting | `AI-DEPLOY.md` |
| How the tools fit together | `USAGE.md` |
| Why the protocol / architecture is this way, pitfalls | **`MCP-V2-PLAN.md`** (§3 pitfall list) |
| **Check this install** | `npm run test:smoke` (57 tools); desk features `node claude/test/desk-e2e.mjs` |
| **Changed tool behaviour — regression?** | `pnpm eval` (50 local tasks vs `claude/eval/baseline.json`; don't ship unless it passes) |
| **Changed launch / injection / UA — bot detection?** | `node claude/test/stealth-check.mjs` (local probes, 0 findings; `--online` for public sites) |
| AI tool-use exam (draft, not enabled) | `claude/eval/mcp-exam/SPEC.md` (owner note `docs/review/2026-10-14-exam-proposal.md`) |
| Codex config and troubleshooting | `CODEX.md` |
| ~~`HTTP-DESIGN.md`~~ | Old session architecture **replaced by pipes**; history only |

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

## Judge layer (AI must not modify)

`claude/eval/**` (exam, test pages, pass rules, baseline), root and `claude/` `package.json` (exception: release commits bump `version` only), `claude/tsconfig.json`, `.ankotti/evolve.json`, CI config. Improve the code under test until `pnpm eval` passes; judge-layer changes are auto-closed. Baseline (`pnpm eval:baseline`) is updated by humans only.
Anti-cheat: baseline is read before the service under test starts; judge files are fingerprinted before and after (changed → fail, exit 3); the service gets whitelisted env only, HOME / USERPROFILE / APPDATA point to a temp dir (no bastion key); the evolve pipeline runs `claude/eval/**` from trusted main, no credentials, no network.

## Development rules

- **stdio is first-class**: must run without PM2 or ports (`node dist/server.js --stdio`).
- Keep the HTTP leg: **the only way to share across machines** (named pipes are local).
- Never commit `.env` or credentials (pushes are mirrored to a private GitHub repo; history is permanent).
- Tool behaviour changed → update `USAGE.md`; install / config changed → update `UPDATE-PROMPT.md` and `mcp.mjs config`.
- After TypeScript changes: build in `claude/`, then `npm run test:smoke`.

## Updating the local MCP

Staff PCs update themselves (local host / ai-kit switch to the release-center version when the browser is idle; `node ~/.ankotti/ai-kit/browser-mcp.mjs status` shows the running version and manager). Only on a **git-installed dev machine**, when the user says "更新本地 MCP": `node claude/mcp.mjs update` (git pull --ff-only, reinstall deps, check Chromium, rebuild `dist/`, restart running PM2 services; aborts on uncommitted changes). Then tell the user (in Chinese) to `/mcp` reconnect in Claude Code or restart Codex. Upgrading **v1 → v2** needs `rm -rf node_modules package-lock.json` first (see `UPDATE-PROMPT.md`).
