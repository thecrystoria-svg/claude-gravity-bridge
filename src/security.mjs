// Security helpers. Everything the bridge returns or logs goes through here.
import path from 'node:path';

export const LIMITS = {
  promptMax: 20000,
  reportMax: 200000,      // bytes read from an outbox report
  returnMax: 12000,       // chars returned to Claude in one reply
  screenMax: 4000,
  maxActive: 1,
  maxPerHour: 30,
  waitMax: 45000,         // single long-poll never exceeds this (stays under MCP client timeouts)
  taskTimeoutDefault: 30 * 60 * 1000,
  taskTimeoutMax: 4 * 60 * 60 * 1000,
};

// Patterns for secrets. Used both to REFUSE outgoing prompts and to REDACT incoming text.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s'"]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bre_[A-Za-z0-9]{20,}\b/g,                  // Resend
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,           // GitHub
  /\bnpg_[A-Za-z0-9]{12,}\b/g,                 // Neon
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,         // Slack
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,               // Google API
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
];

export function looksSecret(text) {
  const s = String(text);
  return SECRET_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(s); });
}

export function redact(text) {
  let s = String(text);
  for (const re of SECRET_PATTERNS) { re.lastIndex = 0; s = s.replace(re, '[REDACTED]'); }
  return s;
}

export function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : s.slice(0, max) + `\n…[clipped ${s.length - max} chars]`;
}

// Strip control characters (keeps \n and \t) so a prompt can never smuggle terminal/escape codes.
export function sanitizePrompt(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').replace(/\r\n?/g, '\n');
}

export const ID_RE = /^[a-f0-9]{16}$/;
export function validId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new BridgeError('bad_id', 'Task id must be 16 hex characters.');
  return id;
}

// Join and verify the result stays inside root (blocks ../ and absolute-path tricks).
export function safeJoin(root, ...parts) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + path.sep)) throw new BridgeError('path_escape', 'Path leaves the bridge folder.');
  return full;
}

export function isLoopbackHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
