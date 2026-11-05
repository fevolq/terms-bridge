import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fixture, request, successRun, listenHttp } from './helpers.mjs';
import { handler } from '../dist/http/api.js';
import { sendCallback } from '../dist/http/callback.js';

async function server(t, fn) {
  const s = createServer(fn); await listenHttp(s);
  t.after(async () => { s.closeAllConnections(); await new Promise(r => s.close(r)); });
  return `http://127.0.0.1:${s.address().port}`;
}
test('real HTTP API enforces project auth, duplicate rejection, query and input validation', async t => {
  const f = await fixture({ run: successRun });
  const base = await server(t, handler(f.engine, '/v1', f.transfer));
  const post = (body, authorization = 'Bearer test-request-token', headers = {}) => fetch(base + '/v1/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json', authorization, ...headers }, body: JSON.stringify(body),
  });
  assert.equal((await post(request(), 'Bearer wrong')).status, 401);
  const admitted = await post(request()); assert.equal(admitted.status, 202);
  assert.equal(admitted.headers.get('location'), '/v1/projects/news/conversations/task-1/chats/chat-1');
  assert.equal((await post(request())).status, 409);
  assert.equal((await post({ ...request(), instruction: 'changed' })).status, 409);
  assert.equal((await post(request(), undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(base + '/v1/tasks')).status, 405);
  await f.cycle();
  const found = await fetch(base + '/v1/projects/news/conversations/task-1/chats/chat-1', { headers: { Authorization: 'Bearer test-request-token' } });
  assert.equal(found.status, 200); assert.equal((await found.json()).result, 'done');
  const invalid = request('bad'); invalid.metadata.result_schema = {};
  assert.equal((await post(invalid)).status, 400); assert.equal(f.store.list().length, 1);
});

test('real callback POST carries fixed body and token; 2xx succeeds, redirect is not followed', async t => {
  const received = [];
  const base = await server(t, async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received.push({ path: req.url, token: req.headers.authorization, version: req.headers['x-dsh-protocol-version'], body: Buffer.concat(parts).toString() });
    if (req.url === '/redirect') res.writeHead(302, { Location: '/ok' }); else res.writeHead(204);
    res.end();
  });
  const f = await fixture({ run: successRun, overrides: { callback_headers: { Authorization: 'Bearer test-callback-token' } } });
  await f.engine.accept(request()); await f.cycle();
  const r = f.record(); r.project.callback_url = base + '/ok';
  assert.equal(await sendCallback(r, new AbortController().signal), null);
  assert.equal(received[0].body, r.callback_body); assert.equal(received[0].token, 'Bearer test-callback-token');
  assert.equal(received[0].version, '3');
  r.project.callback_url = base + '/redirect';
  assert.equal(await sendCallback(r, new AbortController().signal), 'HTTP 302'); assert.equal(received.length, 2);
  delete r.project.callback_headers;
  r.project.callback_url = base + '/ok';
  assert.equal(await sendCallback(r, new AbortController().signal), null);
  assert.equal(received[2].token, undefined);
});

test('projects without request tokens admit and query without Authorization; configured tokens stay isolated', async t => {
  const f = await fixture({ run: successRun, overrides: { request_token: undefined } });
  const base = await server(t, handler(f.engine, '/v1', f.transfer));
  assert.equal((await fetch(base+'/v1/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request())})).status,202);
  await f.cycle();
  assert.equal((await fetch(base+'/v1/projects/news/conversations/task-1/chats/chat-1')).status,200);
  await f.engine.reconfigure(new Map([['news',{...f.projects.get('news'),request_token:'direct-token'}]]));
  assert.equal((await fetch(base+'/v1/projects/news/conversations/task-1/chats/chat-1')).status,401);
  assert.equal((await fetch(base+'/v1/projects/news/conversations/task-1/chats/chat-1',{headers:{Authorization:'Bearer direct-token'}})).status,200);
});
