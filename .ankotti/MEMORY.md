# localmcpbrower 项目记忆（一屏；细节按下表去取，别通读）

## 现状（2026-10-17）
- 稳定版 **3.0.3**：发布包自带生产依赖、按平台出包；员工电脑由堡垒机本机服务 ankotti-local（≥ 0.1.6）装 / 更新，ai-kit 后备。
- 浏览器：patchright 1.63 + 完整版 Chromium（无头也用它，不装 headless shell）；不做 JS 指纹伪装；体检 `node claude/test/stealth-check.mjs` 0 项破绽。
- 工具 57 个；常驻服务 PM2 `claudemcp-headless` 3215 / `claudemcp-browser` 3213；客户端经 `bin/shim.mjs`（或 `~/.ankotti/browser-mcp/shim.mjs` 启动器）接入。

## 红线
- 裁判层（`claude/eval/**`、两个 `package.json` 除 release 改版本号、`claude/tsconfig.json`、`.ankotti/evolve.json`、CI）AI 不改。
- 不往页面里加指纹伪装；页面脚本只经 CDP 按页装（`browser.ts preparePage`），不回到 route 拦 HTML。
- 不提交凭据；本仓推送后镜像到 GitHub。
- 转正（发给所有人）只有业主本人在面板点；本机服务下发项 AI 可以直接改（可退回）。
- 员工电脑上不跑 npm install / 编译：要装的东西进发布包，Chromium 走公司下载节点。

## 去哪找
| 要做什么 | 读哪 |
|---|---|
| 发版、发布项目、本机服务接管、发版踩坑 | `docs/memory/release.md` |
| 架构、反检测、工位、模块边界 | `docs/architecture.md` |
| 工具怎么用 | `USAGE.md` |
| 协议 / pipe 设计与踩坑清单 | `MCP-V2-PLAN.md` |
| 手动装 / 升级（开发者、没接堡垒机的机器） | `UPDATE-PROMPT.md` |
| 自检 | `npm run test:unit`、`npm run test:smoke`、`pnpm eval`、`node claude/test/release-package-e2e.mjs` |
