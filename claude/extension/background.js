/**
 * 浏览器 MCP 自带扩展的后台(Service Worker)。
 *
 * MCP 不走消息协议,而是用 patchright 的 worker.evaluate() 直接调这里挂在 self.__desk 上的函数,
 * 所以这里只放「浏览器内才做得好」的能力,每个函数返回可 JSON 化的结果:
 *   - 录制:内容脚本把人的操作发过来,按标签页攒起来;
 *   - 网络规则:declarativeNetRequest 会话规则,在浏览器内部拦截,不用每个请求回 Node 问一遍;
 *   - 标签页 / 下载:跨全部窗口的视图。
 * 扩展不声明 web_accessible_resources:网页探测不到它的存在。
 */

const rec = { on: false, startedAt: 0, steps: [], maxSteps: 2000 };

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // 新加载的页面 / iframe 问一句「现在在录吗」(内容脚本读不到 storage.session)
  if (msg && msg.kind === 'desk-rec-query') { reply({ on: rec.on }); return; }
  if (!rec.on || !msg || msg.kind !== 'desk-rec') return;
  if (rec.steps.length >= rec.maxSteps) return;
  rec.steps.push({ ...msg.step, tabId: sender.tab?.id ?? null, frameUrl: sender.url ?? null, top: sender.frameId === 0, ts: Date.now() });
});

// 顶层导航(地址栏输入、链接跳转)也记下来,回放时用 navigate
chrome.webNavigation.onCommitted.addListener((d) => {
  if (!rec.on || d.frameId !== 0) return;
  const typed = ['typed', 'auto_bookmark', 'generated', 'reload'].includes(d.transitionType);
  if (typed || (d.transitionQualifiers || []).includes('from_address_bar')) {
    rec.steps.push({ type: 'navigate', url: d.url, tabId: d.tabId, top: true, ts: Date.now() });
  }
});

async function broadcastRecording(on) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => t.id === undefined ? null : chrome.tabs.sendMessage(t.id, { kind: 'desk-rec-state', on }).catch(() => null)));
}

self.__desk = {
  version: chrome.runtime.getManifest().version,

  async recStart() {
    rec.on = true;
    rec.startedAt = Date.now();
    rec.steps = [];
    await chrome.storage.session.set({ deskRecording: true });
    await broadcastRecording(true);
    return { recording: true, startedAt: rec.startedAt };
  },

  async recStop() {
    rec.on = false;
    await chrome.storage.session.set({ deskRecording: false });
    await broadcastRecording(false);
    return { steps: rec.steps, startedAt: rec.startedAt, stoppedAt: Date.now() };
  },

  recStatus() {
    return { recording: rec.on, steps: rec.steps.length, startedAt: rec.startedAt || null };
  },

  /** 网络规则:patterns 为 urlFilter 列表,resourceTypes 为要整类屏蔽的资源类型(image / media / font / stylesheet …) */
  async setBlockRules(patterns, resourceTypes) {
    const old = await chrome.declarativeNetRequest.getSessionRules();
    const rules = [];
    let id = 1;
    for (const p of patterns || []) rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { urlFilter: p } });
    if ((resourceTypes || []).length) {
      rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { resourceTypes } });
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
    return { rules: rules.length };
  },

  async tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({ id: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active, status: t.status, audible: t.audible === true }));
  },

  async downloads(limit) {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: Math.min(Math.max(limit || 20, 1), 200) });
    return items.map((d) => ({ id: d.id, url: d.finalUrl || d.url, filename: d.filename, state: d.state, bytes: d.bytesReceived, total: d.totalBytes, error: d.error || null, startTime: d.startTime }));
  },
};
