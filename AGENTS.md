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

## Before changing code

Read **`docs/memory/dev-notes.md`**: current shape (services, shim, on-demand window), session semantics, client registration, the five must-know pitfalls (isolated world, per-page CDP scripts, pipe `legacy`, session generations, v2 `outputSchema` error) and how a dev machine updates the local MCP ("更新本地 MCP").

## Judge layer (AI must not modify)

`claude/eval/**` (exam, test pages, pass rules, baseline), root and `claude/` `package.json` (exception: release commits bump `version` only), `claude/tsconfig.json`, `.ankotti/evolve.json`, CI config. Improve the code under test until `pnpm eval` passes; judge-layer changes are auto-closed. Baseline (`pnpm eval:baseline`) is updated by humans only.
Anti-cheat: baseline is read before the service under test starts; judge files are fingerprinted before and after (changed → fail, exit 3); the service gets whitelisted env only, HOME / USERPROFILE / APPDATA point to a temp dir (no bastion key); the evolve pipeline runs `claude/eval/**` from trusted main, no credentials, no network.

## Development rules

- **stdio is first-class**: must run without PM2 or ports (`node dist/server.js --stdio`).
- Keep the HTTP leg: **the only way to share across machines** (named pipes are local).
- Never commit `.env` or credentials (pushes are mirrored to a private GitHub repo; history is permanent).
- Tool behaviour changed → update `USAGE.md`; install / config changed → update `UPDATE-PROMPT.md` and `mcp.mjs config`.
- After TypeScript changes: build in `claude/`, then `npm run test:smoke`.
