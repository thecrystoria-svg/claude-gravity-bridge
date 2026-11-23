import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.mjs';
import { redact, looksSecret, safeJoin, sanitizePrompt } from '../src/security.mjs';
import { startMockApp } from './mock-app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
const mk = (over = {}) => {
  const dir = tmp(); const proj = path.join(dir, 'proj'); fs.mkdirSync(proj);
  const cfg = { bridgeDir: path.join(dir, 'bridge'), projectDir: proj, port: '', portFile: path.join(dir, 'noport'), targetMatch: '', inputSel: '', ...over };
  return { cfg, srv: createServer(cfg), proj };
};
const call = async (srv, name, args = {}) => {
  const r = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { err: r.result.isError, data: JSON.parse(r.result.content[0].text) };
};

test('protocol: initialize, tools/list, ping, unknown method, bad input', async () => {
  const { srv } = mk();
  const i = await srv.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(i.result.protocolVersion, '2024-11-05');
  const l = await srv.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(l.result.tools.length, 10);
  assert.deepEqual((await srv.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  assert.equal((await srv.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code, -32601);
  assert.equal(await srv.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await srv.handle(null)).error.code, -32600);
  assert.equal((await srv.handle([])).error.code, -32600);
  const u = await call(srv, 'rm_rf', {}); assert.ok(u.err); assert.equal(u.data.error, 'unknown_tool');
  const p = await call(srv, '__proto__', {}); assert.ok(p.err);
});

test('stdio process: only JSON on stdout, survives garbage, no listening socket needed', async () => {
  const dir = tmp();
  const child = spawn(process.execPath, [path.join(here, '../src/server.mjs')], { env: { ...process.env, AGY_BRIDGE_DIR: dir, AGY_PROJECT_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => (out += d));
  child.stdin.write('not json\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n\n');
  await new Promise((r) => setTimeout(r, 600));
  child.stdin.end(); await new Promise((r) => child.on('close', r));
  const lines = out.trim().split('\n').map((l) => JSON.parse(l)); // every stdout line must be valid JSON
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].result.tools.length, 10);
});

test('security helpers', () => {
  assert.ok(looksSecret('postgres://u:pw1234567@host/db'));
  assert.ok(looksSecret('password = hunter2hunter2'));
  assert.ok(!looksSecret('Run npm test and report the result'));
  assert.ok(!redact('key re_abcdefghij1234567890ABCD ok').includes('re_abc'));
  assert.ok(!sanitizePrompt('a\u001b[31mb‮c').match(/[\u001b‮]/));
  assert.throws(() => safeJoin('/a/b', '../c'), /leaves/);
  assert.throws(() => safeJoin('/a/b', '/etc/passwd'), /leaves/);
});

test('send: refuses secrets, missing project, bad dir, bad ids', async () => {
  const { srv } = mk();
  assert.equal((await call(srv, 'ag_send', { prompt: 'use postgres://u:pw1234567@h/db' })).data.error, 'secret_in_prompt');
  assert.equal((await call(srv, 'ag_send', { prompt: 'hi', project_dir: '/etc' })).data.error, 'outside_project');
  assert.equal((await call(srv, 'ag_send', { prompt: 'x'.repeat(20001) })).data.error, 'prompt_too_long');
  const none = mk({ projectDir: '' });
  assert.equal((await call(none.srv, 'ag_send', { prompt: 'hi' })).data.error, 'no_project');
  for (const bad of ['../../etc/passwd', 'zz', '', 'a'.repeat(16) + '/../x']) assert.equal((await call(srv, 'ag_result', { task_id: bad })).data.error, 'bad_id');
});

test('fallback: app not running -> manual_pending quickly, never hangs', async () => {
  const { srv } = mk({ port: '49999' });
  const t0 = Date.now();
  const r = await call(srv, 'ag_send', { prompt: 'run tests' });
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(r.data.status, 'manual_pending');
  assert.match(r.data.note, /Read the file .*inbox/);
  assert.ok(fs.existsSync(r.data.inbox_file));
  const s = await call(srv, 'ag_status');
  assert.equal(s.data.app.reachable, false);
});

test('full flow with mock app: submit -> agent obeys file contract -> report returned redacted', async () => {
  const app = await startMockApp({ mode: 'secretReport' });
  const { srv } = mk({ port: String(app.port) });
  try {
    const s = await call(srv, 'ag_status'); assert.equal(s.data.app.reachable, true);
    const d = await call(srv, 'ag_diagnose'); assert.equal(d.data.inputs[0].tag, 'TEXTAREA');
    const r = await call(srv, 'ag_send', { prompt: 'Run npm test' });
    assert.equal(r.data.status, 'submitted');
    const res = await call(srv, 'ag_result', { task_id: r.data.task_id, wait_ms: 5000 });
    assert.equal(res.data.status, 'done');
    assert.equal(res.data.report_status, 'DONE');
    assert.ok(!res.data.report.includes('SuperSecret99') && !res.data.report.includes('re_abcdefghij'), 'secrets must be redacted');
    assert.ok(res.data.report.includes('[REDACTED]'));
    // the bridge never sent an Origin header and never connected to the hostile host advertised by the app
    assert.ok(app.st.originSeen.length >= 3 && app.st.originSeen.every((o) => o === null), 'no Origin header on any connection');
    assert.ok(app.st.calls.includes('Input.insertText'));
    const shot = await call(srv, 'ag_screenshot'); assert.ok(fs.existsSync(shot.data.file));
    const scr = await call(srv, 'ag_read_screen'); assert.match(scr.data.text, /Agent ready/);
  } finally { await app.close(); }
});

test('prompt-injection in a report is returned as data with a warning, never executed', async () => {
  const app = await startMockApp({ mode: 'injectionReport' });
  const { srv } = mk({ port: String(app.port) });
  try {
    const r = await call(srv, 'ag_send', { prompt: 'check' });
    const res = await call(srv, 'ag_result', { task_id: r.data.task_id, wait_ms: 5000 });
    assert.match(res.data.note, /untrusted/i);
  } finally { await app.close(); }
});

test('wrong nonce in .done is ignored; task times out instead of lying', async () => {
  const app = await startMockApp({ mode: 'wrongNonce' });
  const { srv } = mk({ port: String(app.port) });
  try {
    const r = await call(srv, 'ag_send', { prompt: 'x', timeout_minutes: 1 });
    const res = await call(srv, 'ag_result', { task_id: r.data.task_id, wait_ms: 1500 });
    assert.notEqual(res.data.status, 'done');
    srv.box.update(r.data.task_id, { deadline: Date.now() - 1 });
    assert.equal((await call(srv, 'ag_result', { task_id: r.data.task_id })).data.status, 'timeout');
  } finally { await app.close(); }
});

test('no input box found -> manual fallback; Enter ignored -> submit_unverified', async () => {
  const a = await startMockApp({ noInput: true });
  try {
    const m = mk({ port: String(a.port) });
    assert.equal((await call(m.srv, 'ag_send', { prompt: 'x' })).data.status, 'manual_pending');
  } finally { await a.close(); }
  const b = await startMockApp({ submit: 'enter_ignored' });
  try {
    const m = mk({ port: String(b.port) });
    assert.equal((await call(m.srv, 'ag_send', { prompt: 'x' })).data.status, 'submit_unverified');
  } finally { await b.close(); }
});

test('one active task at a time; cancel frees the slot; symlinked report rejected', async () => {
  const app = await startMockApp({ mode: 'silent' });
  const { srv } = mk({ port: String(app.port) });
  try {
    const a = await call(srv, 'ag_send', { prompt: 'one' });
    assert.equal((await call(srv, 'ag_send', { prompt: 'two' })).data.error, 'busy');
    assert.equal((await call(srv, 'ag_cancel', { task_id: a.data.task_id })).data.status, 'cancelled');
    const b = await call(srv, 'ag_send', { prompt: 'three' });
    assert.equal(b.data.status, 'submitted');
    // attacker plants a symlink as the report and a valid-looking done file
    const t = srv.box.get(b.data.task_id);
    const secret = path.join(srv.box.dir, 'secret.txt'); fs.writeFileSync(secret, 'TOPSECRET');
    let linked = true;
    try { fs.symlinkSync(secret, path.join(srv.box.dir, 'outbox', `${t.id}.md`)); }
    catch (e) { if (e.code === 'EPERM' || e.code === 'EACCES') linked = false; else throw e; } // Windows blocks symlinks for normal users
    if (linked) {
      fs.writeFileSync(path.join(srv.box.dir, 'outbox', `${t.id}.done`), t.nonce);
      const res = await call(srv, 'ag_result', { task_id: t.id });
      assert.ok(!JSON.stringify(res.data).includes('TOPSECRET'));
    }
  } finally { await app.close(); }
});

test('port is found in the bridge folder when the home-folder file is unreadable', async () => {
  const app = await startMockApp();
  const m = mk();
  fs.writeFileSync(path.join(m.srv.box.dir, 'port'), String(app.port));
  try { assert.equal((await call(m.srv, 'ag_status')).data.app.reachable, true); } finally { await app.close(); }
  fs.writeFileSync(path.join(m.srv.box.dir, 'port'), '99999999');
  assert.match((await call(m.srv, 'ag_status')).data.app.reason, /1024-65535/);
});

test('non-loopback / bad ports are refused', async () => {
  const { srv } = mk({ port: '80' });
  assert.equal((await call(srv, 'ag_status')).data.app.reachable, false);
  const m = mk({ port: 'abc' });
  assert.equal((await call(m.srv, 'ag_status')).data.app.reachable, false);
});

test('stop button script: clicks only a real stop control, never Allow/Run/Approve', async () => {
  const vm = await import('node:vm');
  const { SCRIPTS } = await import('../src/cdp.mjs');
  const mkEl = (label, x = 10, y = 10) => ({ getAttribute: (a) => (a === 'aria-label' ? label : null), innerText: '', className: '', getBoundingClientRect: () => ({ x, y, width: 20, height: 20 }) });
  const run = (labels, sel) => vm.runInNewContext(SCRIPTS.findStop(sel), { document: { querySelectorAll: () => labels.map((l, i) => mkEl(l, i * 30, 5)) }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  assert.equal(run(['Stop generating', 'Settings']).n, 1);
  assert.equal(run(['Stop', 'Copy']).n, 1);
  assert.equal(run(['Cancel']).n, 1);
  assert.equal(run(['Allow', 'Always allow', 'Run command', 'Approve', 'Accept all', 'Confirm', 'Delete', 'Stop and run command', 'Cancel and deploy']).n, 0);
  assert.equal(run(['Stop', 'Stop agent']).n, 2); // ambiguous -> bridge refuses
  assert.equal(run([]).n, 0);
});

test('ag_stop: clicks exactly one match, refuses none/ambiguous', async () => {
  const app = await startMockApp({ stop: 'one' });
  const m = mk({ port: String(app.port) });
  try {
    const r = await call(m.srv, 'ag_stop'); assert.equal(r.data.clicked, true);
    assert.ok(app.st.calls.filter((c) => c === 'Input.dispatchMouseEvent').length === 3);
  } finally { await app.close(); }
  const b = await startMockApp({ stop: 'none' });
  try { const r = await call(mk({ port: String(b.port) }).srv, 'ag_stop'); assert.equal(r.data.clicked, false); assert.ok(!b.st.calls.includes('Input.dispatchMouseEvent')); } finally { await b.close(); }
  const c = await startMockApp({ stop: 'two' });
  try { const r = await call(mk({ port: String(c.port) }).srv, 'ag_stop'); assert.equal(r.data.reason, 'ambiguous_stop_buttons'); assert.ok(!c.st.calls.includes('Input.dispatchMouseEvent')); } finally { await c.close(); }
});
