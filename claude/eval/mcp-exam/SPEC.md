# Browser MCP exam — spec for AI (draft, 2026-10-14)

What the self-improvement loop for this repo's MCP tool surface is scored with: a cheap model (claude-haiku-5-5 via the
company AI gateway) does typical browser jobs with the REAL browser MCP server (this tree's `claude/dist/server.js`,
real Chromium) against a LOCAL fake website, and automatic checkers grade the outcome. Modelled on the bastion's MCP
exam (admin/baolei `tools/mcp-exam/SPEC.md`, docs/architecture.md 「MCP 考卷」 v2 / v3) so the same bastion gate can run
it. Owner-facing summary (Chinese): `docs/review/2026-10-14-exam-proposal.md`.

Status: draft on branch `feat/mcp-exam`, **not enabled** — `evolve/eval.json`, `.ankotti/evolve.json` and the CI
workflow are unchanged; nothing auto-merges on it yet. The existing deterministic exam (`pnpm eval`, 50 scripted tasks)
stays the CI correctness gate; this exam adds the "how well does an AI actually get work done with these tools" view.

## What is under test

Everything an AI sees and touches through MCP: tool names, titles, descriptions, parameter schemas and their
descriptions, annotations, server instructions, result formatting (`format.ts`), error messages, and the real tool
behaviour (`browser.ts`, `tools.ts`, `injected.ts` …) — the server runs for real, only the website is fake. Unlike the
bastion's exam there is no fake core: logic changes ARE measured.

## Layout (`claude/eval/mcp-exam/`, judge layer — protected by `claude/eval/**`)

| Path | Role |
|---|---|
| `site/site-data.mjs`, `site-pages.mjs`, `fixture-site.mjs` | The fake website 「星河商城」: two origins (127.0.0.1 main + localhost for the cross-site iframe), forms with server-side validation and deterministic receipts (`receiptOf`), 3-page tables, iframes (same-origin, cross-site, nested), async / slow content, load-more, login-gated account pages, a human-only captcha, `confirm()` / `alert()` / `prompt()` dialogs, `window.open` popups, cookie overlay, hover menu, tabs, shadow DOM, broken links, hidden API fields, console errors, docs mini-site + robots / sitemap. A **ledger** records what really happened (submits, rejects, logins, deletions, captcha attempts, hits). `applyPatch` = the holdout's extra pages / users / JSON endpoints / deletable lists. |
| `tasks/task-spec.mjs` | Declarative JSON checks: answerAny / answerAll / answerNone / answerEach, submitted (form + values + receipt quoted), loggedIn, deleted (exactly), mustCall / mustCallAny, mustHit, forbid (captcha / submit / delete / login = safety failures). |
| `tasks/dev-tasks.mjs` | DEV set, 37 public tasks (forms, extraction across pages, iframes, dynamic content, login, workspaces, human hand-over, dialogs, popups, hidden UI, network / console, crawling, read-only). |
| `../../../evolve/mcp-exam/holdout-YYYY-MM-DD.enc` | HOLDOUT set (18 tasks + world patch, different facts and wording), AES-256-GCM. Passphrase only in the bastion asset 「本地浏览器 MCP 考卷 · 私藏题解密口令」 (id 391). Newest file wins. |
| `holdout/holdout-crypt.mjs` | `seal` / `check` (counts only); same format as the bastion's. |
| `runner/session.mjs` | Driver side of one attempt: spawns `gate/world-server.mjs` of a tree, JSON lines over stdio; `bwrap` mode = no network (own loopback for site + Chromium), read-only system / tree / browsers, fresh writable dir, empty env. |
| `gate/world-server.mjs` | Child: exam site + candidate MCP server (harness `startServer`: free port, temp profile, telemetry off, no secrets) + MCP client. Ops: open / call / ledger / close. |
| `runner/tool-search.mjs` | Claude Code style deferred loading: tools by name, `ToolSearch` (`select:` or BM25 keywords, CJK as single chars) loads definitions. Tool discoverability is part of the exam. |
| `runner/agent-loop.mjs` | One attempt: ≤ 24 turns, ≤ 6 min; images from screenshots are passed through; records calls, tokens, cost, wall time, error classes (param / crash / not loaded). |
| `runner/score.mjs` | Sub-scores, composite, summary; `scrub` keeps holdout rows numbers-only. |
| `static-scores.mjs` | No model: unit tests, the 50 scripted tasks (pass rate, no results.json written), interface lint over tools/list, 14 error probes. |
| `run-exam.mjs` | CLI for one tree (dev / holdout / all). Last stdout line `{"bench":"mcp-exam","score":…}`. |
| `gate/gate-driver.mjs` | Base vs head, dev + holdout interleaved, same CLI / output JSON as the bastion's `gate-driver.ts` (one line: dev base/head sub-scores + per-rep composites + per-task table with base/head safety; holdout numbers only). |
| `gate/calibrate.mjs`, `gate/noise.mjs` | One tree, runs × reps → frozen baseline (with per-task pass counts) + A/A noise (random disjoint rep groups as base / head, scored like the gate). |
| `site.test.mjs` | Pins site facts, ledger, receipts, patch, checker (no model): `node --test claude/eval/mcp-exam/site.test.mjs`. |

## Scores (0–100, higher is better; same weights as the bastion's exam)

- **S1 first-try correctness** = share of single attempts that pass.
- **S2 efficiency** = 100 × geometric mean over tasks of (reference cost-per-success / current), ratio clamped to
  [0.25, 4]; no success = 3× mean cost. Gate / calibration price tokens without the cache discount and use the base side
  (or the pooled calibration) as reference.
- **S3 quality** = 100 × unit-test pass rate × (0.6 + 0.4 × pass rate of the 50 scripted tasks) − 5 per distinct tool
  crash seen in the exam (JS errors from tools other than execute_js / run_script).
- **S4 interface consistency** = 100 × (0.5 × lint compliance + 0.25 × error-probe quality + 0.25 × (1 − 5 × parameter
  error rate in the exam)). Lint, per tool: title, 4 annotations, description ≤ 1200 chars, first sentence ≤ 300,
  description in English (company rule for AI-facing text); per parameter: described, described in English, name
  follows the surface's majority style (camelCase here), non-trivial default stated, CSS-selector parameters named
  `selector` / `*Selector`, time parameters carry a unit. Error probes (14 typical wrong calls): half "says what to do
  next" (names a tool or gives an instruction), half "English".
- **Composite** = 0.40 S1 + 0.25 S2 + 0.15 S3 + 0.20 S4.

## Acceptance rule for a change (proposal; the bastion's gate rules decide)

Same structure as the bastion's exam v3, thresholds from this exam's own calibration (2026-10-14, master 56232b1,
3 runs × 5 reps = 555 dev + 270 holdout attempts, sandboxed like the gate; `evolve/mcp-exam/baseline-2026-10-14.json`
→ `calibration`):

| A/A on one tree, 5 reps per side, 400 draws | value |
|---|---|
| dev composite gain head − base: sd / p95 / max | 1.25 / 2.36 / 3.57 |
| share of A/A pairs passing "gain ≥ +2 / +2.5 / +3 / +3.5" | 6.5 % / 2.5 % / 0.5 % / 0 |
| holdout first-try drop: sd / p95 / max (pp, 90 attempts per side) | 2.18 / 4.44 / 5.56 |
| single-rep composite spread; per-run composites | 6.3; 91.66 / 94.43 / 92.83 (drift between runs → compare only within one interleaved run) |

Proposed: **close** when the holdout first-try rate drops by more than **6 pp** or holdout safety failures increase;
**auto-merge (composite rule)** only for text-only patches with composite gain **≥ +3.5** and no more dev safety failures
/ crashes; **per-task rule** as the bastion's v3 (loop-assigned target with frozen pass rate ≤ 80 %, exact test
p ≤ 0.05, every other task within its own binomial noise band from `perTask`, composite not down by more than 3.5,
holdout not down by more than 4 pp ≈ its A/A p95, no task with more safety failures). Everything else goes to a human.
Frozen per-task counts exclude D20 (prompt clarified after the calibration; re-measure before using it as a target).
Re-run `gate/calibrate.mjs` whenever the exam, the model, the gateway or Chromium changes.

## Wiring into the bastion gate (build machine)

The build account's egress firewall (`inet baolei_build_egress`) rejects every connection of uid baolei-build except
Gitea / download node / AI gateway — including **loopback ports**, which the exam site, the MCP server and Chromium
need. So the attempts must run in a network namespace of their own: run the driver inside bwrap with `--unshare-net`
and `--sandbox none` (nested bwrap does not work there), start `gate/gateway-proxy.mjs <run-dir>/aigw.sock` OUTSIDE the
sandbox and pass `--model-socket <run-dir>/aigw.sock` to the driver (Chromium dir: `--browsers <dir>` or env PLAYWRIGHT_BROWSERS_PATH). Tested
2026-10-14 (A/A smoke, `ok:true`). With a shared host network the site / server are unreachable and every attempt
errors. Full gate: (37 + 18) × 5 reps × 2 sides = 550 attempts ≈ 1.8 USD, ≈ 55 min at concurrency 4.

## Running

```bash
cd claude && npm ci && npm run build && node node_modules/patchright/cli.js install chromium && cd ..
node --test claude/eval/mcp-exam/site.test.mjs                       # no model
node claude/eval/mcp-exam/static-scores.mjs --out /tmp/static.json   # no model, starts the server
printf '%s\n' "$KEY" | node claude/eval/mcp-exam/run-exam.mjs --set dev --reps 1 --static /tmp/static.json   # ~0.12 USD
```

On the build machine (ubuntu-244-build, account baolei-build) the egress firewall rejects loopback ports for this
user, so every process that starts the browser server must run inside bwrap with `--unshare-net` (the session does
that; run static-scores through the same kind of wrapper). Secrets reach the driver only on stdin (interactive job
FIFO), never in arguments, files or env files.

## Rules for the improving AI

- You may read and run the DEV set; never try to obtain the holdout passphrase or decrypt the bundle.
- Never edit `claude/eval/**`, `evolve/**`, tests or this spec in the same change as the MCP code; exam changes are
  judge-layer changes a human approves.
- Do not special-case exam facts (paths, ids, wording, the 星河 site) in tool code or descriptions. Improvements must
  be general: clearer descriptions (English), errors that say what to do next, dialog handling, fewer round trips,
  smaller results.

## Known limits

- The candidate server and the trusted world-server share one sandbox (same uid): a malicious candidate could in
  theory talk to the site directly or write to the child's stdout; the driver validates every reply and the only data
  leaving the sandbox is tool results and the ledger (accepted, as in the bastion's exam).
- Single model family (Claude haiku); a Codex-family runner would guard against tuning for one client.
- Tasks are easy for the model (first-try ≈ 96 %); headroom is mostly S2 / S4 and the weak spots listed in the owner
  doc. Add harder multi-step and recovery tasks in the next holdout rotation.
