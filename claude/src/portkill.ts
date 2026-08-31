/**
 * 进程 / 端口清理 —— Windows / Linux / macOS 三平台实现
 *
 * 为什么单独一个文件:原来这套逻辑长在 server.ts 里,只有 `process.platform === 'win32'`
 * 一条真实分支,其余平台形同虚设。三平台铺开后代码量翻了几倍,而且解析部分是**纯函数**、
 * 应该能被单测直接喂样例 —— 但 server.ts 顶层就 `main()` 起服务了,import 它等于起进程,
 * 根本没法在测试里加载。所以把「进程/端口」整块搬到这里:server.ts 只 import 一个
 * killPortProcess,browser.ts 只 import 一个 killProcessTreeSync,解析函数全部导出可测。
 *
 * 贯穿全文件的一条铁律 —— **宁可清不掉,也绝不误杀**:
 * 端口清理跑在服务启动路径上,杀错一个 PID 就是把别人的服务(甚至 PM2 守护进程自己)
 * 连根拔掉。所以每条平台分支都必须**自己**把端口号解析出来做严格数值相等比较,
 * 不允许把「筛选」这件事外包给 findstr / grep 之类的子串匹配工具(见下面 Windows 那段事故)。
 */

import { execSync, spawnSync } from 'child_process';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/** 探测类命令的超时,与原 Windows 实现的 5s 对齐 */
const PROBE_TIMEOUT_MS = 5000;

/**
 * 探测输出的 maxBuffer。
 * Node 给 spawnSync/execSync 的默认值是 1 MiB,超了直接 ENOBUFS —— 端口清理静默失效。
 * 实测(2026-08-31,飞牛 NAS,iproute2-6.1.0):`ss -lptnH` 199 行监听 = **99898 字节**,
 * 因为 ss 会把地址列右对齐补一大堆空格,平均一行 500 字节。
 * 监听数上千的机器就顶到 1 MiB 了,所以和 Windows 分支一样显式放宽到 16 MiB。
 */
const PROBE_MAX_BUFFER = 16 * 1024 * 1024;

/** POSIX 下 SIGTERM 之后给进程的收尾时间,超时才升级到 SIGKILL */
const POSIX_TERM_GRACE_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface ProbeResult {
  /** 命令的 stdout;命令不存在 / 起不来时是空串 */
  out: string;
  /** 真正跑起来且退出码为 0 */
  ok: boolean;
}

/**
 * 跑一条只读探测命令,**任何情况下都不抛异常**。
 *
 * 用 spawnSync 而不是 execSync,两个原因缺一不可:
 *  1) **不过 shell** —— 参数以数组传,端口号再怎么畸形也拼不出第二条命令(纵深防御,
 *     调用方那层已经先做了整数校验);
 *  2) **命令不存在不抛异常** —— execSync 走 shell,找不到程序时 shell 返回 127,execSync
 *     直接 throw;spawnSync 只是把 error.code='ENOENT' 填进返回值。精简容器(distroless /
 *     alpine 最小镜像)里 ss、lsof、ps 一个都可能没有,这里必须优雅降级而不是炸掉启动流程。
 *
 * 注意 **不能**用 `status !== 0` 去判定「没结果」而丢弃 stdout:
 * 实测 lsof 在「一条都没匹配上」时退出码就是 **1**(飞牛 NAS lsof 4.95.0 实测确认),
 * 那是正常的空结果,不是故障。所以 out 照常返回,ok 只用来决定要不要换另一条命令重试。
 */
function probe(command: string, args: readonly string[]): ProbeResult {
  const res = spawnSync(command, [...args], {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_BUFFER,
    windowsHide: true,
    // stderr 丢掉:lsof 会对没权限 stat 的挂载点刷 WARNING,混进日志纯属噪音
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const out = typeof res.stdout === 'string' ? res.stdout : '';
  return { out, ok: !res.error && res.status === 0 };
}

// ============================================================
// 解析层(纯函数,不碰真实系统,可直接喂样例做单测)
// ============================================================

/**
 * 从 `netstat -ano` 的输出里**精确**挑出监听 `port` 的 PID。
 *
 * 原实现是 `netstat -ano | findstr :${port}` —— findstr 是**子串匹配**：
 * 有人监听 127.0.0.1:32110 时 `findstr :3211` 照样命中该行，行尾正则把它的 PID 抠出来，
 * 于是 killPortProcess(3211) 会 `taskkill /F /T` 掉一个**完全无关**的进程连同它整棵进程树。
 * 端口越短命中面越大（:80 能命中 :8080/:8000/:1080…），/T 又把误杀半径放大到子进程树。
 *
 * 这里改成按列解析，同时要求三件事全部成立才收下这个 PID：
 *   1) 协议列以 TCP 开头（兼容部分 Windows 把 IPv6 行标成 TCPv6；
 *      UDP 行只有 4 列、没有状态列，被下面的列数/状态判断天然挡掉）
 *   2) 本地地址的**端口字段**严格等于 port —— 取最后一个 ':' 之后的部分做数值比较，
 *      IPv6 的 `[::1]:3215` / `[::]:3215` 同样正确（不会被 `::` 里的冒号带偏）
 *   3) 状态是 LISTENING —— 否则一条源端口恰好是 3215 的**出站连接**也会被当成占用者杀掉
 *
 * 不加 `-p TCP` 过滤：实测 Windows 的 `netstat -ano -p TCP` 只出 IPv4 行，
 * 绑在 `[::1]` / `[::]` 上的监听会整个看不见 —— 那样端口被 IPv6 占用时清不掉，
 * 反而比原实现更糟。全量取回来在这里自己判协议列。
 *
 * 非英文 Windows 的 netstat 只本地化表头，状态值仍是 ASCII 的 LISTENING；
 * 表头乱码行过不了「第一列以 TCP 开头」这关，被自然跳过。
 */
export function parseWindowsListenerPids(netstatOutput: string, port: number): Set<string> {
  const pids = new Set<string>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // 期望列序: Proto | Local Address | Foreign Address | State | PID
    if (cols.length < 5) continue;
    const [proto, local, , state, pid] = cols;
    if (!proto?.toUpperCase().startsWith('TCP')) continue;
    if (state?.toUpperCase() !== 'LISTENING') continue;
    if (!local || !pid || !/^\d+$/.test(pid)) continue;
    const sep = local.lastIndexOf(':');
    if (sep < 0) continue;
    if (Number(local.slice(sep + 1)) !== port) continue;
    pids.add(pid);
  }
  return pids;
}

/**
 * 把一个「地址:端口」字段里的端口取出来,严格等于 port 才算命中。
 * Windows 那份的同款判据,抽出来给 POSIX 两个解析器共用:
 * 取**最后一个** ':' 之后的部分,IPv6 的 `[::]:12800` / `[fe80::1%eth0]:63219` 都不会被
 * 地址里的冒号带偏;端口部分必须是纯数字(`0.0.0.0:*` 这种 peer 列的 `*` 直接出局)。
 */
function fieldPortEquals(field: string, port: number): boolean {
  const sep = field.lastIndexOf(':');
  if (sep < 0) return false;
  const tail = field.slice(sep + 1);
  if (!/^\d+$/.test(tail)) return false;
  return Number(tail) === port;
}

/** POSIX 侧统一把 PID 收成 number(要直接喂 process.kill),顺手挡掉溢出/0/负数 */
function addPid(pids: Set<number>, raw: string): void {
  const pid = Number(raw);
  if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
}

/**
 * 解析 Linux `ss -lptnH` 的输出,挑出监听 `port` 的 PID。
 *
 * 真实样例(2026-08-31 从飞牛 NAS 实抓,iproute2-6.1.0):
 * ```
 * LISTEN 0  4096          0.0.0.0:12800 0.0.0.0:* users:(("docker-proxy",pid=14924,fd=7))
 * LISTEN 0  30 172.17.0.1%docker0:63219 0.0.0.0:* users:(("qbittorrent-nox",pid=4611,fd=64))
 * LISTEN 0  511           0.0.0.0:5667  0.0.0.0:* users:(("nginx",pid=176598,fd=8),("nginx",pid=4140,fd=8))
 * LISTEN 0  4096             [::]:37065    [::]:*
 * ```
 * 从这几行能读出四个**必须**处理的现实(全都不是臆想,是抓出来的):
 *  1) 地址列可能带网卡 scope 后缀 `%docker0` / `%br-7ed3b951cfa8`,IPv6 更是
 *     `[fe80::4849:eaff:fe5b:8efb]%vethaca4314:63219` —— 只能按**最后一个冒号**切端口;
 *  2) 一个端口可以有**多个 PID**(SO_REUSEPORT:实测 nginx 13 个 worker 挂同一行),
 *     所以是把整行的 `pid=` 全收下,不是取第一个;
 *  3) 有的监听行**根本没有 users:() 字段**(内核态 socket,或非 root 跑 `ss -p` 时看不见
 *     别人的进程)—— 匹配到端口但一个 PID 都取不到是**正常结果**,不是异常;
 *  4) 行尾有大量右对齐填充空格,先 trim 再切。
 *
 * 判据(与 Windows 那份对齐,只信自己解析出来的东西):
 *   - 状态列必须是 LISTEN(允许它在第 0 或第 1 列 —— 某些 ss 版本会多一个 Netid 列);
 *   - 必须存在一个字段的端口部分**严格等于** port(不做任何子串匹配);
 *   - PID 从 `pid=NNN` 抓,该写法只出现在 users:() 里,不会误抓地址或队列长度。
 *
 * 表头行(`ss` 不带 -H 时的 `State Recv-Q Send-Q Local Address:Port …`)既不是 LISTEN
 * 开头、端口字段也不是数字,天然被跳过 —— 所以老版本 iproute2 不认 `-H` 时可以直接
 * 回落到不带 -H 的命令,解析器不用改。
 */
export function parseSsListenerPids(ssOutput: string, port: number): Set<number> {
  const pids = new Set<number>();
  for (const line of ssOutput.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // 至少要有 状态 + 两个队列列 + 本地地址
    if (fields.length < 4) continue;
    if (fields[0] !== 'LISTEN' && fields[1] !== 'LISTEN') continue;
    if (!fields.some((f) => fieldPortEquals(f, port))) continue;
    for (const m of line.matchAll(/\bpid=(\d+)/g)) {
      const raw = m[1];
      if (raw) addPid(pids, raw);
    }
  }
  return pids;
}

/**
 * 解析 lsof **完整格式**的输出(Linux 回落路径与 macOS 主路径共用 —— 两边格式一模一样,
 * 抄一份出来只会多一处将来忘记同步改的地方)。
 *
 * 真实样例(2026-08-31 从飞牛 NAS 实抓,lsof 4.95.0;macOS 的 lsof 列序相同):
 * ```
 * COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
 * docker-pr 14924 root    7u  IPv4  83594      0t0  TCP *:12800 (LISTEN)
 * docker-pr 14932 root    7u  IPv6  83595      0t0  TCP *:12800 (LISTEN)
 * ```
 *
 * ⚠️ **为什么不用 `lsof -t`(只吐 PID)**:那种输出没有端口列,解析器**无从校验**,
 * 只能盲信 lsof 自己的过滤 —— 而本文件顶上那次 Windows 事故的根因,正是盲信了
 * findstr 的过滤。lsof 的 `-iTCP:PORT` 确实是精确匹配(实测 `-iTCP:1280` 在
 * 12800 正在监听时返回空),但「它现在是对的」和「我们能自己验证它是对的」是两件事:
 * 换个 lsof 版本 / 被人误改成 `-i :PORT` 就再也没人拦得住。所以坚持要完整格式,
 * 端口自己解析、自己比。
 *
 * 另外两个必须带的开关:
 *   -P:**不要**把端口翻译成 /etc/services 里的服务名。否则 80 会显示成 `*:http`,
 *      数值比较直接失效(而且会静默失效 —— 什么都匹配不到,端口永远清不掉)。
 *   -n:不做反向 DNS,避免 DNS 不通时整条命令卡到超时。
 *
 * 判据:PID 列是纯数字(表头 `COMMAND PID USER …` 的 "PID" 天然出局,lsof 刷到 stdout
 * 的 WARNING 行也一样),行尾有 `(LISTEN)` 标记,且它前一列(NAME 列)的端口严格等于 port。
 */
export function parseLsofListenerPids(lsofOutput: string, port: number): Set<number> {
  const pids = new Set<number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN) —— 最少 10 列
    if (fields.length < 10) continue;
    const pid = fields[1];
    if (!pid || !/^\d+$/.test(pid)) continue;
    const stateIdx = fields.lastIndexOf('(LISTEN)');
    if (stateIdx < 1) continue;
    const name = fields[stateIdx - 1];
    if (!name) continue;
    // LISTEN 行不会有 `->`(那是已建立连接的形态),这里切一刀纯属纵深防御:
    // 万一调用方漏了 -sTCP:LISTEN,也只会拿本地端口去比,不会拿对端端口比。
    const local = name.split('->')[0] ?? '';
    if (!fieldPortEquals(local, port)) continue;
    addPid(pids, pid);
  }
  return pids;
}

/**
 * 解析 `ps -o pgid= -p <pid>` 的输出。
 * 实测输出是右对齐带前导空格的一行(`      1`),`pgid=` 这个写法会抑制表头。
 * 进程不存在时输出为空、退出码 1 —— 返回 null,由调用方降级成「只杀单个进程」。
 */
export function parsePgid(psOutput: string): number | null {
  for (const line of psOutput.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\d+$/.test(t)) {
      const pgid = Number(t);
      if (Number.isSafeInteger(pgid) && pgid > 0) return pgid;
    }
  }
  return null;
}

// ============================================================
// 查询层:各平台怎么问系统「谁在监听这个端口」
// ============================================================

/** Linux:优先 ss,回落 lsof */
function findLinuxListenerPids(port: number): Set<number> {
  // -l 只列监听 / -p 带进程信息 / -t 只要 TCP / -n 不翻译端口号 / -H 去表头
  let res = probe('ss', ['-lptnH']);
  // 老 iproute2(< 4.4)不认 -H,会直接报错退出;去掉 -H 重来一次,
  // 表头那行解析器本来就会跳过。注意只在「跑失败且没有任何输出」时才重试 ——
  // ss 正常跑完但一条监听都没有时 ok=true,不该白白再跑一遍。
  if (!res.ok && !res.out) res = probe('ss', ['-lptn']);
  const pids = parseSsListenerPids(res.out, port);
  if (pids.size > 0) return pids;

  // 走到这里有三种可能:ss 不存在(精简容器)/ ss 版本不兼容 / ss 看得见监听但看不见 PID
  // (非 root 跑 `ss -p` 拿不到别人进程的信息)。lsof 再试一次,拿到就是赚到。
  return findPidsByLsof(port);
}

/** macOS:没有 ss,lsof 是唯一选择(系统自带,不需要额外装) */
function findMacListenerPids(port: number): Set<number> {
  return findPidsByLsof(port);
}

/** lsof 查询(Linux 回落 + macOS 主路径共用) */
function findPidsByLsof(port: number): Set<number> {
  // 刻意不加 -t:见 parseLsofListenerPids 的注释 —— 端口要自己解析、自己比。
  return parseLsofListenerPids(probe('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).out, port);
}

// ============================================================
// 击杀层
// ============================================================

/** 进程还活着吗。EPERM = 存在但没权限发信号,同样算活着 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读某个进程的进程组 id;ps 不可用或进程已退出返回 null */
function readPgid(pid: number): number | null {
  const res = probe('ps', ['-o', 'pgid=', '-p', String(pid)]);
  return parsePgid(res.out);
}

/**
 * 判断能不能对这个 PID 用「杀进程组」(`kill(-pid)`)。
 *
 * 为什么非要杀进程组:chromium 会 fork 出一堆子进程(renderer / GPU / zygote / network),
 * 只杀主进程会留下一地孤儿,它们仍然持有 user_data 的 profile 锁,下次启动直接失败 ——
 * 这正是 Windows 那边要用 `taskkill /T` 的同一个理由。
 *
 * 但 `kill(-pid)` 的语义是「杀掉**进程组 id 等于 pid** 的那一整组」,不是「杀 pid 的子孙」。
 * 所以必须先确认目标**真的是组长**(pgid === pid),否则组 pid 要么不存在(ESRCH,白跑),
 * 要么是别人的组 —— 那就是又一次误杀。
 *
 * 还有一条更要命的自保判据:**目标和我们自己同组时绝不能组杀**。
 * 典型现场:PM2 重启本服务,老实例和新实例都是 PM2 God 守护进程的子进程、同一个进程组;
 * 这时 `kill(-pgid)` 会把 PM2 守护进程连同它管的所有服务一起带走 —— 从「清个端口」
 * 升级成「整台机器的服务全灭」。宁可只杀单个进程、留几个孤儿,也不能捅这一刀。
 */
function shouldKillGroup(pid: number, selfPgid: number | null): boolean {
  const pgid = readPgid(pid);
  if (pgid === null) return false;                       // ps 不可用 → 保守只杀单进程
  if (pgid !== pid) return false;                        // 不是组长 → -pid 打到的可能是别人的组
  if (selfPgid !== null && pgid === selfPgid) return false; // 和自己同组 → 组杀会把自己也杀了
  return true;
}

interface PosixTarget {
  pid: number;
  /** true = 发给进程组(-pid),false = 只发给这一个进程 */
  group: boolean;
}

function signalTarget(t: PosixTarget, signal: NodeJS.Signals): void {
  try {
    process.kill(t.group ? -t.pid : t.pid, signal);
  } catch {
    // 已经死了 / 没权限,都没什么可做的
  }
}

/**
 * POSIX 端口清理:先 SIGTERM 给收尾机会,超时不死再 SIGKILL。
 *
 * 为什么不像老实现那样直接 `kill -9`:占端口的十有八九是**上一个自己**(PM2 重启、
 * 升级、手动重跑)。SIGKILL 会让它的 process.on('exit') / SIGTERM 钩子一个都跑不了 ——
 * 而本服务的 chromium 回收、profile 锁释放全挂在那些钩子上。等于我们为了抢端口,
 * 亲手制造了下一轮「浏览器起不来」。给 1.5 秒体面退出,划算得多。
 *
 * 两轮批处理而不是逐个 PID 串行等:一个端口可能被多个进程持有(SO_REUSEPORT,
 * 实测 nginx 13 个 worker 同一行),串行等的话总耗时会被进程数乘起来。
 */
async function killPortPosix(port: number): Promise<void> {
  const found = IS_MAC ? findMacListenerPids(port) : findLinuxListenerPids(port);
  // 排除自己是显然的;连**父进程**一起排除是因为 systemd socket activation 那类场景下,
  // 端口的持有者是把 fd 传给我们的父进程(极端情况就是 pid 1)—— 那不是「残留的旧实例」,
  // 杀了它就是把整台机器的 init 干掉。清不掉端口最多启动失败,这一刀捅下去无法挽回。
  const pids = [...found].filter((pid) => pid !== process.pid && pid !== process.ppid);
  if (pids.length === 0) return;

  // 自己的 pgid 只读一次,给 shouldKillGroup 当自保判据用
  const selfPgid = readPgid(process.pid);
  const targets: PosixTarget[] = pids.map((pid) => ({ pid, group: shouldKillGroup(pid, selfPgid) }));

  for (const t of targets) signalTarget(t, 'SIGTERM');

  let alive = targets;
  const deadline = Date.now() + POSIX_TERM_GRACE_MS;
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter((t) => isAlive(t.pid));
  }
  // 还赖着不走的,SIGKILL 收尾
  for (const t of alive) signalTarget(t, 'SIGKILL');
}

/** Windows 端口清理 —— 逻辑与改造前逐字一致,只是从 server.ts 搬了个家 */
function killPortWindows(port: number): void {
  // 不再用 findstr 预筛（子串匹配会把 :32110 当成 :3211），整份输出交给精确解析。
  // 取全量表就有了旧实现没有的失败模式：连接数极多的机器（数万条 TIME_WAIT）会超过
  // execSync 默认 1 MiB 的 maxBuffer 抛 ENOBUFS，端口清理直接失效 —— 显式放宽到 16 MiB。
  const output = execSync('netstat -ano', { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  for (const pid of parseWindowsListenerPids(output, port)) {
    if (pid === String(process.pid)) continue;
    // /T 连同**子进程树**一起杀：旧 server 被 TerminateProcess 硬杀时它的 exit 钩子
    // 一个都不会跑，不带 /T 就要靠 chromium 自己发现 CDP 管道断开才退出；
    // 浏览器卡住（模态框 / 渲染进程无响应）时就会留下持有 profile 锁的孤儿。
    // 前提是 PID 挑得准 —— 挑错了 /T 会把误杀面从一个进程放大到一整棵树。
    try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }); } catch {}
  }
}

/**
 * 清掉占着 `port` 的监听进程。启动 HTTP 服务前调用,失败一律吞掉(尽力而为:
 * 清不掉的话后面 listen 会 EADDRINUSE,那条路径自己有重试和报错)。
 */
export async function killPortProcess(port: number): Promise<void> {
  // 端口先做整数校验再进 shell 命令:既挡住命令注入,也顺手挡住 NaN 拼出的畸形命令
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  try {
    if (IS_WIN) {
      killPortWindows(port);
    } else {
      await killPortPosix(port);
    }
  } catch {}
}

/**
 * **同步**杀掉一个进程连同它的子进程树 —— 给 process.on('exit') 这类只能同步收尾的
 * 钩子用(chromium 回收)。绝不抛异常。
 *
 * Windows:`taskkill /F /T` 会**显式遍历子进程树**。原来这里是 `process.kill(pid,'SIGKILL')`,
 *   Node 在 Windows 上把它翻译成对**单个进程**的 TerminateProcess —— 子孙进程死不死
 *   完全取决于它们有没有被谁放进同一个 job object,不是我们能保证的事
 *   (本机实测过一棵 node→cmd 的树:单进程 TerminateProcess 之后子进程确实也跟着没了,
 *    但那是 job object 连坐的结果 —— chromium 渲染进程卡死时不能指望这份运气)。
 *   patchright 自己在 Windows 上就是用 `taskkill /pid X /T /F`(见
 *   patchright-core/lib/coreBundle.js),这里与它对齐:显式收树,不赌连坐。
 *   taskkill 万一不可用(极精简的 Windows 容器镜像),仍回退到原来的单进程 SIGKILL,
 *   行为不比改造前差。
 *
 * POSIX:`kill(-pid)` 杀整个进程组。这里可以放心用组杀而**不必**像 killPortPosix
 *   那样先验组长身份,因为 patchright 是用 `detached: true` spawn 浏览器的
 *   (coreBundle.js 里写死:`detached: process.platform !== "win32"`,注释明说就是为了
 *   能用 `.kill(-pid)` 收整棵树),chromium 必然是自己那个组的组长。
 *   而且「我们自己的进程组 id 等于某个活着的 chromium 的 pid」在逻辑上不可能发生
 *   (组 id 就是组长的 pid,而 chromium 不是我们的组长),所以组杀伤不到自己。
 *   万一哪天 patchright 改了策略、组不存在,ESRCH 会走到下面的单进程 SIGKILL。
 */
export function killProcessTreeSync(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (IS_WIN) {
    try {
      const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        stdio: 'ignore'
      });
      if (!res.error && res.status === 0) return;
    } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return;
  } catch {
    // 组不存在(没 detached 起来)→ 退回单进程
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}
