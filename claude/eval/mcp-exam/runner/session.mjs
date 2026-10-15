/**
 * Driver side of one exam attempt: starts gate/world-server.mjs of the given tree as a child process and talks JSON lines
 * with it. mode "bwrap" (build machine, production): no network (own loopback only, where the exam site and Chromium
 * live), read-only system and tree, fresh writable temp dir per attempt, empty environment. mode "none": local
 * development only, no isolation. The driver (trusted base code) keeps the model key and the holdout tasks in its own
 * memory; the child sees only the site patch and the tool calls. Judge layer.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_LINE = 8 * 1024 * 1024;
const OPEN_TIMEOUT = 180_000;
const CALL_TIMEOUT = 150_000;

/**
 * @param spec { tree, mode: 'bwrap'|'none', node, cacheDir, browsers? }
 *   tree     repo root whose claude/dist + claude/node_modules are under test (claude/eval comes from the base tree)
 *   browsers PLAYWRIGHT_BROWSERS_PATH holding the patchright Chromium (read-only in the sandbox)
 */
export function bwrapArgs(spec, entry, own) {
  const nodeHome = path.dirname(path.dirname(spec.node));
  const ro = [nodeHome, spec.tree, ...(spec.browsers ? [spec.browsers] : [])];
  return [
    '--die-with-parent', '--new-session',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--unshare-net',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home', '--tmpfs', '/root',
    ...ro.flatMap((d) => ['--ro-bind', d, d]),
    '--bind', own, own,
    '--chdir', path.join(spec.tree, 'claude'),
    '--clearenv',
    '--setenv', 'PATH', `${path.join(nodeHome, 'bin')}:/usr/bin:/bin`,
    '--setenv', 'HOME', own, '--setenv', 'TMPDIR', own, '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'NO_COLOR', '1',
    ...(spec.browsers ? ['--setenv', 'PLAYWRIGHT_BROWSERS_PATH', spec.browsers] : []),
    '--', spec.node, entry,
  ];
}

export function sessionFactory(spec) {
  fs.mkdirSync(spec.cacheDir, { recursive: true });
  const entry = path.join(spec.tree, 'claude/eval/mcp-exam/gate/world-server.mjs');
  return async (patch) => {
    const own = fs.mkdtempSync(path.join(spec.cacheDir, 'att-'));
    const env = { PATH: process.env.PATH ?? '', TMPDIR: own, TEMP: own, TMP: own, NO_COLOR: '1', ...(spec.browsers ? { PLAYWRIGHT_BROWSERS_PATH: spec.browsers } : {}) };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) if (process.env[k]) env[k] = process.env[k];
    const child = spec.mode === 'bwrap'
      ? spawn('bwrap', bwrapArgs(spec, entry, own), { stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(spec.node, [entry], { cwd: path.join(spec.tree, 'claude'), stdio: ['pipe', 'pipe', spec.debug ? 'inherit' : 'ignore'], env, windowsHide: true });
    const rpc = new ChildRpc(child);
    const cleanup = () => { try { fs.rmSync(own, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best effort */ } };
    let opened;
    try {
      opened = await rpc.call({ op: 'open', patch: patch ?? null }, OPEN_TIMEOUT);
    } catch (e) {
      await rpc.close();
      cleanup();
      throw e;
    }
    const site = { main: String(opened?.site?.main ?? ''), other: String(opened?.site?.other ?? '') };
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(site.main) || !/^http:\/\/localhost:\d+$/.test(site.other)) { await rpc.close(); cleanup(); throw new Error('exam child returned a bad site origin'); }
    return {
      site,
      instructions: typeof opened.instructions === 'string' ? opened.instructions : '',
      tools: Array.isArray(opened.tools) ? opened.tools : [],
      async callTool(name, args) {
        const r = await rpc.call({ op: 'call', name, args }, CALL_TIMEOUT);
        const content = Array.isArray(r?.content) ? r.content.filter((c) => c && (c.type === 'text' || c.type === 'image')) : [];
        return { content, isError: r?.isError === true };
      },
      async ledger() {
        const l = await rpc.call({ op: 'ledger' }, 30_000);
        const arr = (k) => (Array.isArray(l?.[k]) ? l[k] : []);
        return { submits: arr('submits'), rejects: arr('rejects'), logins: arr('logins'), deletes: arr('deletes'), captcha: arr('captcha'), hits: arr('hits') };
      },
      async close() { await rpc.close(); cleanup(); },
    };
  };
}

/** JSON-lines request / response over the child's stdin / stdout; oversized output kills the child */
class ChildRpc {
  constructor(child) {
    this.child = child;
    this.next = 1;
    this.buffer = '';
    this.dead = null;
    this.pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onData(chunk));
    child.on('exit', (code) => this.fail(`exam child exited (${code ?? 'signal'})`));
    child.on('error', (e) => this.fail(`exam child failed to start: ${e.message}`));
    child.stdin.on('error', () => undefined);
  }

  call(msg, timeoutMs) {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`exam child did not answer ${msg.op} in time`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, ...msg })}\n`);
    });
  }

  async close() {
    if (!this.dead) {
      const done = new Promise((r) => this.child.once('exit', r));
      this.child.stdin.write(`${JSON.stringify({ id: 0, op: 'close' })}\n`);
      await Promise.race([done, new Promise((r) => setTimeout(r, 20_000))]);
    }
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    this.fail('closed');
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) { this.child.kill('SIGKILL'); this.fail('exam child sent an oversized line'); return; }
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { msg = null; }
      const w = msg && typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
      if (w) {
        this.pending.delete(msg.id);
        clearTimeout(w.timer);
        if (msg.ok === true) w.resolve(msg.result);
        else w.reject(new Error(typeof msg.error === 'string' ? msg.error.slice(0, 2000) : 'exam child error'));
      }
      nl = this.buffer.indexOf('\n');
    }
  }

  fail(why) {
    this.dead ??= why;
    for (const [id, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error(why)); this.pending.delete(id); }
  }
}
