// Minimal Chrome DevTools Protocol client. Loopback only. No dependencies (uses Node 22+ global WebSocket/fetch).
// It sends NO Origin header, so Chromium's default origin check keeps web pages out; we never pass --remote-allow-origins.
import { BridgeError, isLoopbackHost } from './security.mjs';

export function assertLoopback(host) {
  if (!isLoopbackHost(host)) throw new BridgeError('not_loopback', `Refusing non-local host: ${host}`);
}

export function validPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new BridgeError('bad_port', 'CDP port must be 1024-65535.');
  return n;
}

export async function listTargets(port, timeoutMs = 3000) {
  const n = validPort(port);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${n}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BridgeError('cdp_unreachable', `Antigravity is not listening on 127.0.0.1:${n} (start it with scripts/start-antigravity.ps1).`);
  }
  if (!res.ok) throw new BridgeError('cdp_http', `CDP answered HTTP ${res.status}.`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

export function pickTarget(targets, match) {
  const pages = targets.filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'));
  if (!pages.length) throw new BridgeError('no_page', 'No app window found on the debug port.');
  const re = new RegExp(match || 'antigravity|workbench', 'i');
  return pages.find((t) => re.test(`${t.title} ${t.url}`)) || pages[0];
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }

  static async connect(port, target, timeoutMs = 5000) {
    const n = validPort(port);
    const u = new URL(target.webSocketDebuggerUrl);
    u.hostname = '127.0.0.1'; u.port = String(n); u.protocol = 'ws:'; // never trust a host from the response
    const ws = new WebSocket(u.toString());
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { ws.close(); } catch {} reject(new BridgeError('cdp_timeout', 'CDP connect timed out.')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new BridgeError('cdp_connect', 'CDP websocket refused (is another tool attached?).')); });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject, timer } = c.pending.get(m.id); clearTimeout(timer); c.pending.delete(m.id);
        m.error ? reject(new BridgeError('cdp_error', `${m.error.message || 'CDP error'}`)) : resolve(m.result || {});
      }
    });
    ws.addEventListener('close', () => { for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError('cdp_closed', 'CDP connection closed.')); } c.pending.clear(); });
    return c;
  }

  send(method, params = {}, timeoutMs = 8000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('cdp_timeout', `${method} timed out.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new BridgeError('cdp_send', 'CDP send failed.')); }
    });
  }

  async evalValue(expression, timeoutMs = 8000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) throw new BridgeError('cdp_js', 'Page script failed.');
    return r.result ? r.result.value : undefined;
  }

  close() { try { this.ws.close(); } catch {} }
}

// ---- Fixed page scripts. Claude can never supply script text; only these constants run. ----

const FIND_INPUT = `(() => {
  const SEL = (window.__AGY_SEL__ || '');
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 40 && r.height > 12 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const all = [...document.querySelectorAll(SEL || 'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], .monaco-editor textarea')].filter(vis);
  const score = (e) => {
    const t = [e.getAttribute('aria-label'), e.getAttribute('placeholder'), e.getAttribute('data-placeholder'), e.className, e.closest('[aria-label]')?.getAttribute('aria-label')].join(' ').toLowerCase();
    let s = 0;
    if (/agent|chat|ask|prompt|message|assistant|instruction/.test(t)) s += 5;
    if (e.tagName === 'TEXTAREA') s += 1;
    if (/editor-widget|inputarea|find|search|replace|terminal/.test(t)) s -= 6;
    if (e.closest('.monaco-editor') && !/agent|chat/.test(t)) s -= 4;
    return s;
  };
  all.sort((a, b) => score(b) - score(a));
  return all.map((e) => ({ tag: e.tagName, aria: e.getAttribute('aria-label') || '', ph: e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '', cls: String(e.className).slice(0, 80), score: score(e) }));
})()`;

export const SCRIPTS = {
  candidates: (sel) => `(() => { window.__AGY_SEL__ = ${JSON.stringify(sel || '')}; return ${FIND_INPUT}; })()`,
  focusBest: (sel) => `(() => {
    window.__AGY_SEL__ = ${JSON.stringify(sel || '')};
    const list = ${FIND_INPUT};
    if (!list.length || list[0].score < 1) return { ok: false, reason: 'no_confident_input', n: list.length };
    const SEL2 = ${JSON.stringify(sel || '')} || 'textarea, [contenteditable="true"], [contenteditable=""], input[type="text"], .monaco-editor textarea';
    const els = [...document.querySelectorAll(SEL2)];
    const want = list[0];
    const el = els.find((e) => e.tagName === want.tag && (e.getAttribute('aria-label') || '') === want.aria && String(e.className).slice(0, 80) === want.cls);
    if (!el) return { ok: false, reason: 'lost_element' };
    el.focus();
    if (el.select) { try { el.select(); } catch (e) {} }
    return { ok: document.activeElement === el, picked: want };
  })()`,
  inputText: () => `(() => { const a = document.activeElement; if (!a) return ''; return String(a.value !== undefined ? a.value : a.textContent || '').slice(0, 2000); })()`,
  screenText: (n) => `(() => String(document.body ? document.body.innerText : '').slice(-${Number(n) || 4000}))()`,
};

// Buttons Claude may click: ONLY a stop/cancel control. Anything that could grant permission or confirm an action is refused.
const BTN_COMMON = `
  const BAD = /allow|approve|accept|run|deploy|delete|remove|confirm|yes|continue|proceed|apply|install|trust|always|grant|authorize|submit|send|push|merge|commit/i;
  const GOOD = /^\\s*(stop|cancel|interrupt)\\b|\\b(stop|cancel|interrupt)\\b.{0,20}(generat|agent|response|task|run|conversation|execution|request)/i;
  const lab = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('data-tooltip-content'), e.innerText].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 6 && r.height > 6 && s.visibility !== 'hidden' && s.display !== 'none'; };
`;
SCRIPTS.findStop = (sel) => `(() => { ${BTN_COMMON}
  const SEL = ${JSON.stringify(sel || '')} || 'button, [role="button"]';
  const els = [...document.querySelectorAll(SEL)].filter(vis);
  const all = els.map((e) => { const r = e.getBoundingClientRect(); return { label: lab(e), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; });
  const hits = all.filter((b) => (${JSON.stringify(!!sel)} || GOOD.test(b.label)) && !BAD.test(b.label));
  return { n: hits.length, hit: hits[0] || null, candidates: all.filter((b) => b.label).slice(0, 40).map((b) => b.label) };
})()`;
SCRIPTS.buttons = () => `(() => { ${BTN_COMMON}
  return [...document.querySelectorAll('button, [role="button"]')].filter(vis).slice(0, 80).map((e) => ({ label: lab(e), tag: e.tagName, cls: String(e.className).slice(0, 50) }));
})()`;
