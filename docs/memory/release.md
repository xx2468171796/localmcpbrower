# Release and update channels (since 2026-10-17)

Staff PCs get the browser MCP from the **bastion local host ankotti-local** (owner 2026-10-17: default channel) as a **run-as-unpacked** package: no npm install, no build on PCs. PCs without the local host fall back to the **ai-kit updater**. Only dev machines and machines without the bastion use git + build (`UPDATE-PROMPT.md`).

## Release projects (bastion release center)

| Project | Used by | File |
|---|---|---|
| `localmcpbrower-windows-x86_64` / `localmcpbrower-linux-x86_64` | local host (component `localmcpbrower`) | `localmcpbrower-<os>-<arch>-<v>.tgz` |
| `localmcpbrower` | ai-kit `browser-mcp.mjs` (fallback) | `localmcpbrower-<v>.tgz` |

Same content in all three (prod deps have no native modules). Package: `claude/` (dist, bin, extension, PM2 configs, **production node_modules** without `.bin`), `release.json` (project / version / commit / `deps: true`), root `manifest.json` (sha256 per file). Chromium is not packed: `claude/bin/install-browser.mjs` installs the full build (no headless shell) from mirror nodes' `/playwright`.

## Ship a version

1. Change code → `cd claude && npm run build && npm run test:unit`; tool behaviour changed → `pnpm eval` at repo root (must pass).
2. Bump `version` in `claude/package.json` + `package-lock.json` only; commit `release: <v> —— <中文一句话>`; push master.
3. Pack: `cd claude && node scripts/pack-release.mjs --version <v> --platform all` (→ repo-root `release/`; deps installed clean from the lockfile in a temp dir).
4. Verify (recommended): `node test/release-package-e2e.mjs --mirror <entry>…` — pack → unpack to an empty dir → Chromium only → smoke; no npm install.
5. Upload to `sz:/opt/baolei-dl/evolve/<project>/<v>/<file>`: `mkdir -p` the three dirs on sz, then one bastion `transfer_link` (upload, single use, 60 min) per file.
6. Register: `node scripts/register-release.mjs <v> --note "<中文一句话>"` (try `--dry-run` first). A new project's first version becomes stable; later ones start as canary. Promotion: panel 自我进化 → 待你处理 → 灰度中的版本, **owner only**.
7. Watch: panel 本机服务 device events (`component.installed`), release census `/api/admin/releases/census?project=…`.

## Local-host side (code in the baolei repo)

- Component: baolei `local-host/ankotti-local/src/reconcile/handlers/component/browser_mcp.rs`; notes in baolei `local-host/README.md` "Browser MCP".
- Flow: signed assignment → download via mirror nodes (`<entry>/ankotti-dl/…`) → unpack, sha256 every file, check release.json → `install-browser.mjs` → `release-smoke.mjs` → `host-switch.mjs` (wait ≤ 5 min for an idle browser, swap PM2, check /health version, restore the old version itself if unhealthy).
- Running version = `~/.ankotti/browser-mcp/state.json` `current` (shared by local host, ai-kit, launcher). After a local-host switch it carries `managedBy: "ankotti-local"`; ai-kit ≥ 1.36.1 then stands down.
- Desired item 「浏览器 MCP 保持最新」 (component `localmcpbrower`, all devices, idle 10 min) exists. AI may change desired items directly (audit says 「AI 按本人指示操作」); roll back with `POST /api/admin/local-hosts/items/:id/restore {revision}` or the panel's 历史版本 / 退回.

## Pitfalls

- npm `node_modules/.bin` entries are symlinks on Linux: skip `.bin` while walking (filtering afterwards is too late).
- Git Bash GNU tar treats the colon in `C:\…` as a remote host: unpack with relative paths.
- Windows `npm.cmd` with `shell: true` → DEP0190: call through `cmd.exe /d /s /c`.
- Full Chromium on Linux / macOS dies if the temp dir is long (SingletonSocket path limit): fixed in 3.0.2 (`src/paths.ts`, short `/tmp/lmb-<id>`).
- Another session using the browser during a switch: `host-switch.mjs` exits 3 and changes nothing; for manual tests use `--idle-min 1` (still never interrupts an in-flight call).
