/**
 * shim 的会话续接(纯逻辑,无依赖;shim.mjs 用,test/unit/session-relay.test.mjs 测)。
 *
 * 问题:常驻服务一重启(换版本、崩溃被 PM2 拉起),shim 和它之间的 socket 就断了。以前 shim 跟着退出,
 * 客户端(Claude Code / Codex)那边这个 MCP 就「断开」了,要人手动 /mcp 重连 —— 自动更新每换一次版本就要打扰所有人一次。
 *
 * 做法:shim 按行(MCP stdio = 一行一条 JSON-RPC)看一眼双向消息,记下
 *   - 开场消息:客户端发的第一条请求(initialize,或新协议里定纪元的那条)以及紧随其后的 notifications/initialized;
 *   - 在途请求:客户端发出、还没收到回复的请求 id。
 * socket 断了而客户端还在:给在途请求各回一条错误(让 AI 重试,而不是永远等),重连常驻服务,
 * 用新 id 重放开场消息、吞掉它的回复,再接着转发。客户端感觉不到断线,只是那一两次调用要重试、标签页要重开。
 *
 * 转发的字节原样不动:解析只为了记状态,解析失败的行照样转发。
 */

export const REPLAY_ID_PREFIX = '__shim_replay_';

/** 把字节流切成行(保留不完整的尾巴等下一块) */
export class LineSplitter {
  constructor() {
    this.rest = '';
  }

  /** @param {string} chunk @returns {string[]} 完整的行(不含换行符) */
  push(chunk) {
    const text = this.rest + chunk;
    const parts = text.split('\n');
    this.rest = parts.pop() ?? '';
    return parts;
  }
}

function parse(line) {
  try {
    const msg = JSON.parse(line);
    return msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : null;
  } catch {
    return null;
  }
}

const isRequest = (m) => typeof m.method === 'string' && m.id !== undefined && m.id !== null;
const isNotification = (m) => typeof m.method === 'string' && (m.id === undefined || m.id === null);
const isResponse = (m) => m.method === undefined && m.id !== undefined && m.id !== null && ('result' in m || 'error' in m);

export class SessionRelay {
  constructor() {
    /** 开场请求(原始 JSON 对象) */
    this.opening = null;
    /** 开场后、第一条别的请求之前的通知(notifications/initialized 等) */
    this.openingNotes = [];
    this.openingDone = false;
    /** 在途请求 id(JSON 序列化后当键,数字和字符串 id 不混) */
    this.pending = new Map();
    this.replays = 0;
    this.waitingReplay = null;
  }

  /** 客户端 → 服务的一行:记状态;返回值恒为 true(都要转发) */
  fromClient(line) {
    const m = parse(line);
    if (!m) return true;
    if (isRequest(m)) {
      if (!this.opening) this.opening = m;
      else this.openingDone = true;
      this.pending.set(JSON.stringify(m.id), m.id);
    } else if (isNotification(m)) {
      if (this.opening && !this.openingDone && this.openingNotes.length < 5) this.openingNotes.push(line);
    }
    return true;
  }

  /** 服务 → 客户端的一行:返回 false = 这是重放开场的回复,吞掉不给客户端 */
  fromServer(line) {
    const m = parse(line);
    if (!m) return true;
    if (isResponse(m)) {
      if (this.waitingReplay !== null && m.id === this.waitingReplay) {
        this.waitingReplay = null;
        return false;
      }
      this.pending.delete(JSON.stringify(m.id));
    }
    return true;
  }

  /** socket 断了:给在途请求各一条错误回复(要写到 stdout 的行),并清空 */
  failPending(reason) {
    const lines = [...this.pending.values()].map((id) =>
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: `browser MCP service restarted (${reason}); the call was interrupted, please retry it` } }),
    );
    this.pending.clear();
    return lines;
  }

  /** 能不能续接:见过开场请求才行(否则让客户端自己重新握手) */
  canResume() {
    return this.opening !== null;
  }

  /** 重连后要先发给服务的行;重放请求的 id 记在 waitingReplay,回复由 fromServer 吞掉 */
  replayLines() {
    if (!this.opening) return [];
    const id = `${REPLAY_ID_PREFIX}${++this.replays}`;
    this.waitingReplay = id;
    return [JSON.stringify({ ...this.opening, id }), ...this.openingNotes];
  }
}
