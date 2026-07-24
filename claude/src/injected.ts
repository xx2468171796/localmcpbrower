/**
 * 页面注入层 — 供「snapshot 工具」与「run_script(__ego 一次跑完)」共享同一套 DOM 逻辑。
 *
 * 设计目标(对齐 ego-lite 的「写一段 JS 一次跑完」执行模型):
 *   - 避免 call→read→call 的多次 MCP 往返:agent 在一次 run_script 里
 *     snapshot→填表→点击→等待→读结果全干完,token/延迟大幅下降。
 *   - 快照 walker 抽成单一函数字符串 WALKER_FN,snapshot 工具按 frame 逐个 evaluate
 *     以支持跨 iframe(见 tools.snapshot),__ego.snapshot() 复用同一份实现,不重复维护。
 */

/**
 * 无障碍快照 walker 的函数源码(字符串形式,供 page/frame.evaluate 注入)。
 * 签名: egoSnapshot(interactiveOnly, cap, startRef) -> { snapshot, refCount, truncated }
 *   - startRef: ref 起始编号(跨 frame 合并时让编号全局连续、不冲突)。
 *   - 会在「本文档」内为可交互元素打 data-mcp-ref="e<n>",并清理上一轮遗留标记。
 */
export const SNAPSHOT_WALKER_FN = `function egoSnapshot(interactiveOnly, cap, startRef) {
  interactiveOnly = !!interactiveOnly;
  cap = cap || 12000;
  var INTERACTIVE_ROLES = ['button','link','checkbox','menuitem','tab','switch','radio','option','treeitem'];
  var lines = [];
  var refCount = startRef || 0;
  var truncated = false;
  var totalLen = 0;

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function isInteractive(el) {
    var tag = el.tagName.toLowerCase();
    if (['a','button','input','select','textarea'].indexOf(tag) !== -1) return true;
    var role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.indexOf(role) !== -1) return true;
    if (el.hasAttribute('onclick')) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer') return true; } catch (e) { /* noop */ }
    if (el.hasAttribute('tabindex')) {
      var ti = parseInt(el.getAttribute('tabindex'), 10);
      if (!isNaN(ti) && ti >= 0) return true;
    }
    return false;
  }
  function roleOf(el) {
    var role = el.getAttribute('role');
    if (role) return role;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  }
  function nameOf(el) {
    var n = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (!n) {
      if (el.tagName.toLowerCase() === 'input' && el.value) n = el.value;
      else n = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    }
    if (n.length > 80) n = n.slice(0, 80) + '\\u2026';
    return n.replace(/"/g, "'");
  }
  function emit(depth, txt) {
    if (totalLen >= cap) { truncated = true; return; }
    var line = new Array(depth + 1).join('  ') + txt;
    lines.push(line);
    totalLen += line.length + 1;
  }
  function walk(node, depth) {
    if (truncated || depth > 25 || !node) return;
    for (var i = 0; i < node.children.length; i++) {
      if (truncated) return;
      var el = node.children[i];
      var tag = el.tagName.toLowerCase();
      if (['script','style','noscript','svg','head','meta','link'].indexOf(tag) !== -1) continue;
      if (!isVisible(el)) continue;
      var meaningful = isInteractive(el) || /^h[1-6]$/.test(tag) || el.hasAttribute('role');
      var role = roleOf(el);
      if (meaningful && role) {
        var refStr = '';
        if (isInteractive(el)) {
          refCount++;
          var ref = 'e' + refCount;
          el.setAttribute('data-mcp-ref', ref);
          refStr = ' [ref=' + ref + ']';
        }
        if (!interactiveOnly || isInteractive(el)) {
          emit(depth, role + ' "' + nameOf(el) + '"' + refStr);
        }
        walk(el, depth + 1);
      } else if (!interactiveOnly) {
        var ownText = '';
        for (var j = 0; j < el.childNodes.length; j++) {
          var cn = el.childNodes[j];
          if (cn.nodeType === 3) ownText += cn.textContent;
        }
        ownText = ownText.replace(/\\s+/g, ' ').trim();
        if (ownText && el.children.length === 0) {
          if (ownText.length > 120) ownText = ownText.slice(0, 120) + '\\u2026';
          emit(depth, 'text "' + ownText.replace(/"/g, "'") + '"');
        } else {
          walk(el, depth);
        }
      } else {
        walk(el, depth);
      }
    }
  }
  var prev = document.querySelectorAll('[data-mcp-ref]');
  for (var k = 0; k < prev.length; k++) prev[k].removeAttribute('data-mcp-ref');
  walk(document.body, 0);
  return { snapshot: lines.join('\\n'), refCount: refCount, truncated: truncated };
}`;

/**
 * __ego 一次跑完 helper 的自安装源码(幂等,供 addInitScript 与 run_script 前置注入)。
 *
 * 页面内可用 API(全部返回可 JSON 序列化的简单值,便于 run_script 直接拿结果):
 *   __ego.snapshot({interactiveOnly?, maxChars?})  当前页无障碍快照(主框架)
 *   __ego.click(selOrRef)                          点击(先按 ref 再按 CSS 选择器解析)
 *   __ego.fill(selOrRef, value) / __ego.type(...)  写入输入框并派发 input/change 事件
 *   __ego.check(selOrRef, checked?)                勾选/取消复选框
 *   __ego.select(selOrRef, value)                  选择下拉项(按 value 或可见文本)
 *   __ego.text(selOrRef)                           读文本
 *   __ego.attr(selOrRef, name)                     读属性
 *   __ego.exists(selOrRef)                         元素是否存在
 *   __ego.waitFor(selector, timeoutMs?)            轮询等待元素出现且可见(默认 8000ms)
 *   __ego.sleep(ms)                                延时
 *   __ego.$(selOrRef) / __ego.$$(selector)         querySelector / querySelectorAll(数组)
 *
 * selOrRef: 既接受 CSS 选择器,也接受 snapshot 返回的 ref(如 e5) —— 优先按 ref 解析。
 */
export const EGO_HELPER_SRC = `(function () {
  if (window.__ego && window.__ego.__v) return;
  ${SNAPSHOT_WALKER_FN}
  function resolve(sel) {
    if (sel && typeof sel === 'object' && sel.nodeType === 1) return sel;
    var s = String(sel);
    try {
      var byRef = document.querySelector('[data-mcp-ref="' + s.replace(/"/g, '') + '"]');
      if (byRef) return byRef;
    } catch (e) { /* noop */ }
    try { return document.querySelector(s); } catch (e) { return null; }
  }
  function must(sel) {
    var el = resolve(sel);
    if (!el) throw new Error('元素未找到: ' + sel);
    return el;
  }
  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }
  function click(sel) { must(sel).click(); return true; }
  function fill(sel, value) {
    var el = must(sel);
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') { el.value = String(value); fire(el, 'input'); fire(el, 'change'); return true; }
    el.focus && el.focus();
    if ('value' in el) { el.value = String(value); } else { el.textContent = String(value); }
    fire(el, 'input'); fire(el, 'change');
    return true;
  }
  function check(sel, checked) {
    var el = must(sel);
    el.checked = checked === undefined ? true : !!checked;
    fire(el, 'input'); fire(el, 'change');
    return el.checked;
  }
  function select(sel, value) {
    var el = must(sel);
    var opts = el.options || [];
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === String(value) || (opts[i].textContent || '').trim() === String(value)) {
        el.selectedIndex = i; fire(el, 'input'); fire(el, 'change'); return opts[i].value;
      }
    }
    throw new Error('未找到匹配选项: ' + value);
  }
  function text(sel) { var el = resolve(sel); return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null; }
  function attr(sel, name) { var el = resolve(sel); return el ? el.getAttribute(name) : null; }
  function exists(sel) { return !!resolve(sel); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }
  function isVisibleEl(el) {
    if (!el) return false;
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function waitFor(selector, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    return new Promise(function (resolveP) {
      (function poll() {
        var el = resolve(selector);
        if (el && isVisibleEl(el)) return resolveP(true);
        if (Date.now() > deadline) return resolveP(false);
        setTimeout(poll, 100);
      })();
    });
  }
  window.__ego = {
    __v: 1,
    snapshot: function (o) { o = o || {}; return egoSnapshot(!!o.interactiveOnly, o.maxChars || 12000, 0); },
    click: click, fill: fill, type: fill, check: check, select: select,
    text: text, attr: attr, exists: exists, waitFor: waitFor, sleep: sleep,
    $: resolve,
    $$: function (s) { try { return Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { return []; } }
  };
})();`;
