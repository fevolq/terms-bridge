import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseConfig } from '../dist/projects/config.js';
import { callbackHeadersError } from '../dist/shared/rules.js';
import { createEditor } from '../client/model.mjs';
import { DEFAULT_PROJECT, validateDraft } from '../client/fields.mjs';
import { fixture, request, successRun, listenHttp } from './helpers.mjs';
import { sendCallback } from '../dist/http/callback.js';

const base = { provider: 'test', model: 'model', agent_preset: 'standard', max_concurrency: 1, callback_url: 'http://localhost/results' };
test('header JSON is validated identically by editor and backend; blank is optional', () => {
  const valid = { Authorization: 'Basic abc==', 'X-API-Key': 'key', 'X-Project': 'project-1', Cookie: 'session=example', 'X-Empty': '' };
  const draft = text => validateDraft({ api_prefix: '/api/terms-bridge', rows: [{ ...DEFAULT_PROJECT, ...base, id: 'news', key: 'a', callback_headers: text }] });
  assert.deepEqual(draft('').config.projects.news.callback_headers, {});
  assert.deepEqual(draft(JSON.stringify(valid)).config.projects.news.callback_headers, valid);
  assert.deepEqual(parseConfig({ projects: { news: { ...base, callback_headers: valid } } }).projects.news.callback_headers, valid);
  for (const invalid of [null, [], 'token', { key: 1 }, { key: ['one'] }, { key: {} }, { 'X Bad': 'x' }, { 'X-Test': 'a\r\nb: c' }, { 'X-Test': '中文' }, { Authorization: 'one', authorization: 'two' }, { 'Content-Type': 'text/plain' }, { Host: 'other' }, { 'Content-Length': '99' }, { 'X-DSH-Protocol-Version': '2' }, { a: 'x'.repeat(8192) }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['X-' + i, 'x']))]) {
    assert.ok(callbackHeadersError(invalid));
    assert.ok(draft(JSON.stringify(invalid)).errors['a.callback_headers']);
    assert.throws(() => parseConfig({ projects: { news: { ...base, callback_headers: invalid } } }));
  }
  assert.ok(draft('{bad').errors['a.callback_headers']);
  assert.throws(() => parseConfig({ projects: { news: { ...base, callback_token: 'removed-field' } } }));
});

test('editor round-trips objects as JSON text, persists objects and redacts custom credentials on failure', async () => {
  let snapshot = { status: 'ready', writable: true, revision: 1, value: { projects: { news: { ...base, callback_headers: { 'X-API-Key': 'secret-api-key' } } } } };
  let reject = false;
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async ops => {
    if (reject) throw new Error('Rejected secret-api-key');
    const value = structuredClone(snapshot.value);
    for (const op of ops) {
      let target = value;
      for (const key of op.path.slice(0, -1)) target = target[key] ??= {};
      if (op.op === 'set') target[op.path.at(-1)] = op.value; else delete target[op.path.at(-1)];
    }
    snapshot = { ...snapshot, revision: 2, value }; return true;
  } };
  const editor = createEditor(form);
  let row = editor.getSnapshot().draft.rows[0]; assert.deepEqual(JSON.parse(row.callback_headers), { 'X-API-Key': 'secret-api-key' });
  editor.project(row.key, 'callback_headers', '{"X-API-Key":"secret-api-key","Authorization":"Bearer test"}');
  assert.equal(await editor.save(), true);
  assert.deepEqual(snapshot.value.projects.news.callback_headers, { 'X-API-Key': 'secret-api-key', Authorization: 'Bearer test' });
  row = editor.getSnapshot().draft.rows[0]; reject = true;
  editor.project(row.key, 'name', 'changed'); assert.equal(await editor.save(), false);
  assert.ok(!editor.getSnapshot().message.includes('secret-api-key'));
  assert.equal(editor.getSnapshot().dirty, true); editor.dispose();
});

test('real callback retries use original multiple headers; no implicit Bearer or credentials when empty', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body }); res.writeHead(received.length === 1 ? 503 : 204); res.end();
  });
  await listenHttp(server);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const f = await fixture({ run: successRun, callback: sendCallback, overrides: {
    callback_url: `http://127.0.0.1:${server.address().port}/results`,
    callback_headers: { Authorization: 'Basic original', 'X-API-Key': 'old-key', 'X-Tenant': 'tenant-a' },
  } }); t.after(() => f.engine.close());
  await f.engine.accept(request()); await f.cycle(); await f.cycle();
  f.projects.get('news').callback_headers = { 'X-API-Key': 'new-key' };
  f.advance(60000); await f.cycle(); assert.equal(f.record().delivery.status, 'delivered');
  assert.equal(received.length, 2); assert.deepEqual(received[0].body, received[1].body);
  for (const { headers } of received) {
    assert.equal(headers.authorization, 'Basic original'); assert.equal(headers['x-api-key'], 'old-key'); assert.equal(headers['x-tenant'], 'tenant-a');
    assert.equal(headers['content-type'], 'application/json'); assert.equal(headers['x-dsh-protocol-version'], '3');
  }
  f.projects.get('news').callback_headers = {};
  await f.engine.accept(request('empty')); await f.cycle(); await f.cycle();
  assert.equal(received[2].headers.authorization, undefined); assert.equal(received[2].headers['x-api-key'], undefined);
});
