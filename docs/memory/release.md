# 发版与更新通道（2026-10-17 起）

结论：员工电脑上的浏览器 MCP 由**堡垒机本机服务 ankotti-local** 装 / 更新（业主 2026-10-17 定为默认通道），下的是**解开就能跑**的发布包，电脑上不 npm install、不编译；本机服务还没装的电脑由 **ai-kit 更新器**兜底。开发者自己的机器和没接堡垒机的机器才走 git + 构建（`UPDATE-PROMPT.md`）。

## 发布项目（堡垒机发布中心）

| 项目 | 谁用 | 包 |
|---|---|---|
| `localmcpbrower-windows-x86_64` / `localmcpbrower-linux-x86_64` | 本机服务（组件 `localmcpbrower`） | `localmcpbrower-<os>-<arch>-<版本>.tgz` |
| `localmcpbrower` | ai-kit `browser-mcp.mjs`（后备） | `localmcpbrower-<版本>.tgz` |

三个包内容相同（生产依赖没有原生模块），只是项目分开登记。包里：`claude/`（dist、bin、extension、PM2 配置、**生产 node_modules**，不含 `.bin`）、`release.json`（project / version / commit / `deps: true`）、根上 `manifest.json`（每个文件的 sha256）。Chromium 不进包，各平台在电脑上由 `claude/bin/install-browser.mjs` 从公司下载节点 `/playwright` 装（只装完整版，不装 headless shell）。

## 发一个版本（照做）

1. 改代码 → `cd claude && npm run build && npm run test:unit`；改了工具行为再跑仓库根的 `pnpm eval`（要放行）。
2. 版本号：`claude/package.json` 和 `package-lock.json` 的 version（历次 release 提交只改这两处），提交 `release: <版本> —— 一句话`，推 master。
3. 打包：`cd claude && node scripts/pack-release.mjs --version <版本> --platform all`（输出到仓库根 `release/`，依赖在临时目录按锁文件装一份干净的）。
4. 验包（可选但建议）：`node test/release-package-e2e.mjs --mirror <下载节点入口>…`——打包→解到空目录→只装 Chromium→冒烟，全程不 npm install。
5. 上传到安装源 `sz:/opt/baolei-dl/evolve/<项目>/<版本>/<文件>`：先在 sz 上 `mkdir -p` 三个目录，再用堡垒机 `transfer_link`（upload）各传一个（链接一次性、60 分钟）。
6. 登记：`node scripts/register-release.mjs <版本> --note "<一句话>"`（先 `--dry-run` 看一眼）。新项目第一版直接稳定版，其余先灰度；转正在面板「自我进化 → 待你处理 → 灰度中的版本」，**只有业主本人能点**。
7. 看效果：面板「本机服务」设备详情的事件（`component.installed`）、发布中心版本普查（`/api/admin/releases/census?project=…`）。

## 本机服务那一侧（代码在堡垒机仓库）

- 组件实现：baolei `local-host/ankotti-local/src/reconcile/handlers/component/browser_mcp.rs`；说明在 baolei `local-host/README.md`「Browser MCP」。
- 流程：签名清单 → 下载节点下包（`<入口>/ankotti-dl/…`）→ 解包逐个核 sha256 + 核 release.json → `install-browser.mjs` → `release-smoke.mjs` → `host-switch.mjs`（等浏览器空闲 ≤ 5 分钟、PM2 换版本、/health 核版本，不健康自己退回）。
- 「本机在跑哪个版本」= `~/.ankotti/browser-mcp/state.json` 的 `current`（本机服务、ai-kit、启动器 `shim.mjs` 共用）；本机服务换好写 `managedBy: "ankotti-local"`，ai-kit ≥ 1.36.1 见了就停手。
- 下发项「浏览器 MCP 保持最新」（组件 `localmcpbrower`，所有设备，空闲 10 分钟生效）已建。下发项 AI 可以直接建 / 改 / 撤（免验证码，审计写「AI 按本人指示操作」），做错了 `POST /api/admin/local-hosts/items/:id/restore {revision}` 或面板「历史版本 / 退回」。

## 踩过的坑

- Linux 上 npm 的 `node_modules/.bin` 是符号链接：打包时整个跳过（遍历时就跳，不能先遍历再过滤）。
- Git Bash 的 GNU tar 把 `C:\…` 里的冒号当远程主机：解包用相对路径（`release-package-e2e.mjs`）。
- Windows 上 `npm.cmd` 带 `shell: true` 会报 DEP0190：经 `cmd.exe /d /s /c` 调。
- 完整版 Chromium 在 Linux / macOS 上临时目录太长会因 SingletonSocket 路径超长起不来（3.0.2 修，`src/paths.ts` 短目录 `/tmp/lmb-<id>`）。
- 换版本时有别的会话在用浏览器：`host-switch.mjs` 退出码 3、什么都不动；手动测试可 `--idle-min 1`（仍不会打断正在执行的调用）。
