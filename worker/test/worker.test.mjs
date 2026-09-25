// Local tests for the webhook Worker (Node 22+, no packages): `node --test worker/test/`.
// The n8n side is a stub HTTP server on 127.0.0.1 that records what the Worker posts to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { twilioSignature, N8N_TOKEN_HEADER } from '../src/index.js';

const TOKEN = 'test-auth-token-not-real';
const BASE = 'https://desk-worker.example.test';
const CALLER = '+12025550101'; // reserved 555-01xx test range
const DESK = '+12025550199';

let stub, received = [], stubStatus = 200;
test.before(async () => {
  stub = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { received.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(stubStatus, { 'Content-Type': 'application/json' }); res.end('{"received":true}'); });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
});
test.after(() => new Promise(r => stub.close(r)));
test.beforeEach(() => { received = []; stubStatus = 200; });

const env = () => ({ TWILIO_AUTH_TOKEN: TOKEN, N8N_WEBHOOK_URL: `http://127.0.0.1:${stub.address().port}/webhook/callback-desk-intake`, N8N_WEBHOOK_TOKEN: 'n8n-header-token-not-real' });

async function twilioRequest(path, fields, { sign = true, signature, token = TOKEN, e = env() } = {}) {
  const params = new URLSearchParams(fields);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (sign) headers['X-Twilio-Signature'] = signature ?? await twilioSignature(token, BASE + path, params);
  return worker.fetch(new Request(BASE + path, { method: 'POST', headers, body: params.toString() }), e);
}
const callFields = (extra = {}) => ({ CallSid: 'CA00000000000000000000000000000001', AccountSid: 'AC00000000000000000000000000000000', From: CALLER, To: DESK, CallStatus: 'ringing', Direction: 'inbound', ...extra });
const waFields = (extra = {}) => ({ MessageSid: 'SM00000000000000000000000000000001', AccountSid: 'AC00000000000000000000000000000000', From: 'whatsapp:' + CALLER, To: 'whatsapp:' + DESK, Body: 'Hi, can someone look at a leak on Tuesday?', NumMedia: '0', ...extra });

// ---- signature ----
test('signature: matches an HMAC-SHA1 reference computed outside JavaScript', async () => {
  // Expected value from Python's hmac/hashlib over url + sorted key+value pairs (Twilio's documented scheme),
  // so this does not just compare the implementation with itself. Reserved 555-01xx numbers only.
  const params = new URLSearchParams({ To: '+12025550199', From: '+12025550101', Digits: '1234', Caller: '+12025550101', CallSid: 'CA1234567890ABCDE' });
  assert.equal(await twilioSignature('12345', 'https://desk-worker.example.test/twilio/voice?probe=1', params), 'eA9QaY0vGbSeIkovtEkwo1rhSyI=');
});

test('signature: valid request is accepted and forwarded', async () => {
  const res = await twilioRequest('/twilio/voice', callFields());
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
});

test('signature: forged signature is rejected with 403 and nothing reaches n8n', async () => {
  const res = await twilioRequest('/twilio/voice', callFields(), { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('signature: signed with the wrong auth token is rejected', async () => {
  const res = await twilioRequest('/twilio/whatsapp', waFields(), { token: 'some-other-token' });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('signature: a body changed after signing is rejected', async () => {
  const good = await twilioSignature(TOKEN, BASE + '/twilio/whatsapp', new URLSearchParams(waFields()));
  const res = await twilioRequest('/twilio/whatsapp', waFields({ Body: 'tampered' }), { signature: good });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('signature: missing header is rejected with 403', async () => {
  const res = await twilioRequest('/twilio/voice', callFields(), { sign: false });
  assert.equal(res.status, 403);
  assert.equal(received.length, 0);
});

test('signature: PUBLIC_BASE_URL is used when the public URL differs from the one the Worker sees', async () => {
  const e = { ...env(), PUBLIC_BASE_URL: 'https://desk.example.test/' };
  const params = new URLSearchParams(callFields());
  const sig = await twilioSignature(TOKEN, 'https://desk.example.test/twilio/voice', params);
  const res = await worker.fetch(new Request(BASE + '/twilio/voice', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: params.toString() }), e);
  assert.equal(res.status, 200);
});

// ---- missed call ----
test('missed call: unforwarded inbound call becomes a missed_call event and neutral TwiML', async () => {
  const res = await twilioRequest('/twilio/voice', callFields());
  assert.equal(res.headers.get('Content-Type'), 'text/xml; charset=utf-8');
  const body = await res.text();
  assert.match(body, /^<\?xml version="1.0" encoding="UTF-8"\?><Response><Say>[^<]+<\/Say><Hangup\/><\/Response>$/);
  const sent = received[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/webhook/callback-desk-intake');
  assert.equal(sent.headers[N8N_TOKEN_HEADER.toLowerCase()], 'n8n-header-token-not-real');
  const ev = JSON.parse(sent.body);
  assert.deepEqual(Object.keys(ev).sort(), ['at', 'dialStatus', 'id', 'phone', 'source', 'type']);
  assert.equal(ev.type, 'missed_call');
  assert.equal(ev.id, 'twilio-call-CA00000000000000000000000000000001');
  assert.equal(ev.phone, CALLER);
  assert.equal(ev.source, 'twilio-voice');
  assert.ok(!Number.isNaN(Date.parse(ev.at)));
  assert.equal('actor' in ev, false); // the route assigns the actor, never the request
});

test('missed call: with FORWARD_TO the first leg rings staff and is not forwarded yet', async () => {
  const e = { ...env(), FORWARD_TO: '+12025550150' };
  const res = await twilioRequest('/twilio/voice', callFields(), { e });
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20" action="/twilio/voice" method="POST">+12025550150</Dial></Response>');
  assert.equal(received.length, 0);
});

test('missed call: Dial outcome no-answer is forwarded; completed is not', async () => {
  const e = { ...env(), FORWARD_TO: '+12025550150' };
  const missed = await twilioRequest('/twilio/voice', callFields({ DialCallStatus: 'no-answer' }), { e });
  assert.equal(missed.status, 200);
  assert.equal(received.length, 1);
  assert.equal(JSON.parse(received[0].body).dialStatus, 'no-answer');
  const answered = await twilioRequest('/twilio/voice', callFields({ CallSid: 'CA00000000000000000000000000000002', DialCallStatus: 'completed' }), { e });
  assert.match(await answered.text(), /<Response><Hangup\/><\/Response>$/);
  assert.equal(received.length, 1);
});

// ---- WhatsApp ----
test('whatsapp: message becomes a message event and the reply TwiML is empty', async () => {
  const res = await twilioRequest('/twilio/whatsapp', waFields());
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const ev = JSON.parse(received[0].body);
  assert.equal(ev.type, 'message');
  assert.equal(ev.id, 'twilio-msg-SM00000000000000000000000000000001');
  assert.equal(ev.phone, CALLER); // whatsapp: prefix stripped
  assert.equal(ev.text, 'Hi, can someone look at a leak on Tuesday?');
  assert.equal(ev.source, 'twilio-whatsapp');
  assert.equal(ev.media, 0);
});

test('whatsapp: a non-WhatsApp sender on the WhatsApp route is rejected with 400', async () => {
  const res = await twilioRequest('/twilio/whatsapp', waFields({ From: CALLER }));
  assert.equal(res.status, 400);
  assert.equal(received.length, 0);
});

// ---- n8n failures and configuration ----
test('n8n: a failing n8n webhook yields 502 so Twilio logs the error', async () => {
  stubStatus = 500;
  const res = await twilioRequest('/twilio/whatsapp', waFields());
  assert.equal(res.status, 502);
  assert.equal(received.length, 1);
});

test('config: missing secrets yield 503 without forwarding', async () => {
  const res = await twilioRequest('/twilio/voice', callFields(), { e: { TWILIO_AUTH_TOKEN: TOKEN } });
  assert.equal(res.status, 503);
  assert.equal(received.length, 0);
});

test('routes: GET on a webhook is 405, unknown path is 404, JSON body is 415', async () => {
  assert.equal((await worker.fetch(new Request(BASE + '/twilio/voice'), env())).status, 405);
  assert.equal((await worker.fetch(new Request(BASE + '/nope'), env())).status, 404);
  assert.equal((await worker.fetch(new Request(BASE + '/twilio/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), env())).status, 415);
});

test('health: reports which secrets are present, never their values; CORS only for ALLOWED_ORIGIN', async () => {
  const e = { ...env(), ALLOWED_ORIGIN: 'https://pages.example.test' };
  const res = await worker.fetch(new Request(BASE + '/health', { headers: { Origin: 'https://pages.example.test' } }), e);
  const raw = await res.text();
  assert.deepEqual(JSON.parse(raw), { service: 'callback-desk-worker', ok: true, configured: { twilio: true, n8n: true } });
  for (const v of [TOKEN, e.N8N_WEBHOOK_TOKEN, e.N8N_WEBHOOK_URL]) assert.equal(raw.includes(v), false);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://pages.example.test');
  const other = await worker.fetch(new Request(BASE + '/health', { headers: { Origin: 'https://elsewhere.example.test' } }), e);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});
