# localmcpbrower memory (one screen; open details via the routing table)

## State (2026-10-17)
- Stable **3.0.3**: release packages bundle production deps, one release project per platform. Staff PCs are installed / updated by the bastion local host ankotti-local (≥ 0.1.6, default channel); ai-kit is the fallback.
- Browser: patchright 1.63 + full Chromium (headless too; no headless shell); no JS fingerprint spoofing; `node claude/test/stealth-check.mjs` must report 0 findings.
- 57 tools; PM2 `claudemcp-headless` 3215 / `claudemcp-browser` 3213; clients via `bin/shim.mjs` or launcher `~/.ankotti/browser-mcp/shim.mjs`.
- Fingerprint workspaces (2026-11-18, owner's ask, not released): `space_new {fingerprint: true}` hands the browser to company infra powerbrowser-core (repo admin/powerbrowser, `docs/core.md`) and attaches over CDP; core + grant live in `~/.ankotti/browser-core/` (this PC only so far; release package does not ship it yet). See architecture §12.1; check `node claude/test/fingerprint-e2e.mjs`.

## Red lines
- Judge layer (`claude/eval/**`, both `package.json` except release version bumps, `claude/tsconfig.json`, `.ankotti/evolve.json`, CI): AI doesn't touch.
- No fingerprint spoofing in pages of browsers this service launches (fingerprint workspaces are spoofed by the core, not here); page scripts only via per-page CDP (`browser.ts preparePage`), never route-injected HTML.
- No credentials in the repo (mirrored to GitHub).
- Promote to all staff (release center) = owner only. Local-host desired items: AI may create / change / retire directly (audited, revertible).
- Never npm install / compile on staff PCs: ship it in the package; Chromium from company mirror nodes.
- AI-only docs in English; replies, commits, release notes, panel text in Chinese.

## Routing
| Need | Read |
|---|---|
| Release, release projects, local-host takeover, release pitfalls | `docs/memory/release.md` |
| Architecture, anti-detection, desks, boundaries | `docs/architecture.md` |
| Tool usage | `USAGE.md` |
| Protocol / pipe design, pitfalls | `MCP-V2-PLAN.md` |
| Manual install (dev machines, no bastion) | `UPDATE-PROMPT.md` |
| Self-checks | `npm run test:unit`, `npm run test:smoke`, `pnpm eval`, `node claude/test/release-package-e2e.mjs` |
