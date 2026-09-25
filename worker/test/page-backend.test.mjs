// The page's optional backend hook (docs/backend.js): demo mode is the default and makes no request;
// a configured URL is probed at /health and labelled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const { CONFIG, probe } = createRequire(import.meta.url)(path.join(DOCS, 'backend.js'));

const fakeFetch = (status, body) => { const calls = []; const f = async (url) => { calls.push(url); if (status === 'throw') throw new TypeError('network'); return { ok: status < 400, json: async () => body }; }; f.calls = calls; return f; };

test('committed page is in demo mode: backend.js ships with an empty URL and is loaded after app.js', () => {
  assert.equal(CONFIG.url, '');
  const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
  assert.ok(html.indexOf('<script src="backend.js">') > html.indexOf('<script src="app.js">'));
});

test('demo mode makes no request', async () => {
  const f = fakeFetch(200, {});
  assert.deepEqual(await probe('', f), { mode: 'demo' });
  assert.equal(f.calls.length, 0);
});

test('configured backend: connected, missing secrets, wrong service, unreachable, non-https', async () => {
  const ok = fakeFetch(200, { service: 'callback-desk-worker', ok: true, configured: { twilio: true, n8n: true } });
  assert.deepEqual(await probe('https://desk-worker.example.test/anything', ok), { mode: 'live', ok: true, label: 'backend connected' });
  assert.deepEqual(ok.calls, ['https://desk-worker.example.test/health']);
  assert.equal((await probe('https://desk-worker.example.test', fakeFetch(200, { service: 'callback-desk-worker', configured: { twilio: true, n8n: false } }))).label, 'backend is missing secrets');
  assert.equal((await probe('https://desk-worker.example.test', fakeFetch(200, { hello: 1 }))).label, 'backend answered, but not as Callback Desk');
  assert.equal((await probe('https://desk-worker.example.test', fakeFetch('throw'))).label, 'backend unreachable');
  const http = fakeFetch(200, {});
  assert.equal((await probe('http://desk-worker.example.test', http)).label, 'backend URL must be https');
  assert.equal(http.calls.length, 0);
});
