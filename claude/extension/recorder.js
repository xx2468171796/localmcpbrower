/**
 * 操作录制(内容脚本,每个页面和 iframe 都有一份)。只在录制开着时工作,平时什么都不做。
 *
 * 记下人的操作,交给后台攒起来,MCP 停止录制后转成 run_flow 流程:
 *   点击 → click;输入框改完 → type(密码框不记内容,转成 fill_secret 待填资产);
 *   下拉框 → select_option;在输入框里回车 → keyboard_press。
 * 选择器要「下次还能找到同一个元素」:稳定 id → 测试属性 / name / aria-label / placeholder
 * → 按钮 / 链接文字(Playwright 的 :has-text)→ 最后才用层级路径。看着像随机生成的 id / class 一律不用。
 * 运行在扩展的隔离世界里,网页拿不到这里的任何东西。
 */
(() => {
  if (window.__deskRecorderInstalled) return;
  window.__deskRecorderInstalled = true;

  let on = false;
  chrome.runtime.sendMessage({ kind: 'desk-rec-query' }).then((r) => { on = Boolean(r && r.on); }).catch(() => {});
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.kind === 'desk-rec-state') on = Boolean(msg.on); });

  const send = (step) => { chrome.runtime.sendMessage({ kind: 'desk-rec', step }).catch(() => {}); };

  // ── 选择器 ──
  const RANDOMISH = /\d{4,}|[a-f0-9]{8,}|^(ember|react|vue|ng|mui|css|sc|jsx|_)[-_]|__|--[a-z0-9]{5,}$/i;
  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder', 'title', 'alt'];
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));
  const unique = (sel, el) => {
    try { const all = el.getRootNode().querySelectorAll(sel); return all.length === 1 && all[0] === el; } catch { return false; }
  };

  function textOf(el) {
    return (el.innerText || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
  }

  function byText(el) {
    const tag = el.tagName.toLowerCase();
    if (!/^(a|button|label|summary|option|li|span|div|td|th)$/.test(tag) && el.getAttribute('role') !== 'button') return null;
    const t = textOf(el);
    if (!t || t.length > 40 || t.includes('"')) return null;
    const sel = `${tag}:has-text("${t}")`;
    // 文字定位交给 Playwright,这里只粗查同 tag 同文字是否唯一
    const same = [...el.getRootNode().querySelectorAll(tag)].filter((x) => textOf(x) === t);
    return same.length === 1 ? sel : null;
  }

  function pathOf(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && !RANDOMISH.test(cur.id)) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sibs = [...parent.children].filter((c) => c.tagName === cur.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function selectorOf(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !RANDOMISH.test(el.id) && unique(`#${esc(el.id)}`, el)) return `#${esc(el.id)}`;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 80 && !RANDOMISH.test(v)) {
        const sel = `${tag}[${a}="${esc(v)}"]`;
        if (unique(sel, el)) return sel;
      }
    }
    return byText(el) || pathOf(el);
  }

  /** 点到图标 / span 时往上找真正可点的元素 */
  function clickable(el) {
    return el.closest('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[onclick]') || el;
  }

  const isTextField = (el) => (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable;

  /**
   * 敏感框:内容一律不记(只记位置,回放时用 fill_secret 从堡垒机取)。
   * 不只认 type=password —— 「显示密码」切成 text 的密码框、验证码框、银行卡框同样不能记明文。
   */
  const SENSITIVE_AUTOCOMPLETE = /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;
  const SENSITIVE_NAME = /pass|pwd|secret|token|otp|totp|2fa|mfa|captcha|验证码|密码|口令|cvv|cvc|card/i;
  function isSecret(el) {
    if (el.type === 'password') return true;
    if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return true;
    const label = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('data-testid')].join(' ');
    return SENSITIVE_NAME.test(label);
  }
  const fillStep = (el) => {
    const secret = isSecret(el);
    return { type: 'fill', selector: selectorOf(el), password: secret, ...(secret ? { length: (el.value || '').length } : { value: el.value }) };
  };

  // ── 事件 ──
  document.addEventListener('click', (e) => {
    if (!on || !e.isTrusted) return;
    const el = clickable(e.composedPath()[0] instanceof Element ? e.composedPath()[0] : e.target);
    if (!(el instanceof Element) || isTextField(el) || el.tagName === 'SELECT') return;
    send({ type: 'click', selector: selectorOf(el), text: textOf(el).slice(0, 60) });
  }, true);

  document.addEventListener('change', (e) => {
    if (!on || !e.isTrusted) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      send({ type: 'select', selector: selectorOf(el), value: el.value, label: opt ? opt.label : undefined });
    } else if (isTextField(el)) {
      send(fillStep(el));
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!on || !e.isTrusted || e.key !== 'Enter' || e.isComposing) return;
    const el = e.target;
    if (el instanceof Element && isTextField(el) && el.tagName !== 'TEXTAREA') {
      // 回车前先把当前值记下(change 可能在回车之后才触发);和 change 分支共用同一个敏感判断
      send(fillStep(el));
      send({ type: 'press', key: 'Enter', selector: selectorOf(el) });
    }
  }, true);
})();
