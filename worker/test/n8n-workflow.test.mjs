// Checks the live n8n export: fresh, credential-free, calendar reachable only through the staff guard,
// and the embedded Code-node steps turn an event into a pending request, an approval and a booked calendar entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url'; import { execFileSync } from 'node:child_process';

const N8N = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'n8n');
const FILE = path.join(N8N, 'callback-desk-live.json');
const raw = fs.readFileSync(FILE, 'utf8');
const wf = JSON.parse(raw);
const byName = Object.fromEntries(wf.nodes.map(n => [n.name, n]));

test('export is fresh: rebuilding from steps.cjs gives the committed file', () => {
  execFileSync(process.execPath, [path.join(N8N, 'build-workflow.mjs')], { stdio: 'pipe' });
  assert.equal(fs.readFileSync(FILE, 'utf8'), raw);
});

test('export is inactive and every credential is a REPLACE_* placeholder', () => {
  assert.equal(wf.active, false);
  const creds = wf.nodes.flatMap(n => Object.values(n.credentials || {}));
  assert.ok(creds.length >= 4);
  for (const c of creds) { assert.match(c.id, /^REPLACE_[A-Z_]+$/); assert.match(c.name, /^REPLACE_[A-Z0-9_]+$/); }
  assert.equal(byName['Create calendar event'].parameters.calendar.value, 'REPLACE_CALENDAR_ID');
  assert.doesNotMatch(raw, /AC[0-9a-f]{32}|sk_live|-----BEGIN|Bearer [A-Za-z0-9]/);
});

test('every webhook requires Header Auth', () => {
  const hooks = wf.nodes.filter(n => n.type === 'n8n-nodes-base.webhook');
  assert.equal(hooks.length, 3);
  for (const h of hooks) assert.equal(h.parameters.authentication, 'headerAuth', h.name);
  assert.notEqual(byName['Worker intake'].credentials.httpHeaderAuth.id, byName['Staff decision'].credentials.httpHeaderAuth.id);
});

test('connections name real nodes; calendar is reachable from Staff decision only via the guard, never from Worker intake', () => {
  for (const [from, c] of Object.entries(wf.connections)) { assert.ok(byName[from], from); for (const out of c.main) for (const t of out) assert.ok(byName[t.node], t.node); }
  const reach = (start, skip) => { const seen = new Set([start]); const q = [start]; while (q.length) { const n = q.shift(); for (const out of (wf.connections[n]?.main || [])) for (const t of out) if (t.node !== skip && !seen.has(t.node)) { seen.add(t.node); q.push(t.node); } } return seen; };
  assert.ok(reach('Staff decision').has('Create calendar event'));
  assert.equal(reach('Worker intake').has('Create calendar event'), false);
  assert.equal(reach('Staff decision', 'Staff approval guard').has('Create calendar event'), false);
  assert.deepEqual(wf.connections['Approved?'].main[0].map(t => t.node), ['Create calendar event']);
  assert.equal(wf.nodes.some(n => /twilio|whatsapp|sms|email/i.test(n.type)), false); // nothing sends a message
});

// Runs a Code node's jsCode the way n8n does: $input and $getWorkflowStaticData provided, return value = output items.
function runCode(nodeName, store, inputs, extra = {}) {
  const ctx = { $getWorkflowStaticData: () => store, $input: { all: () => inputs.map(json => ({ json })) }, ...extra };
  return vm.runInNewContext(`(function(){${byName[nodeName].parameters.jsCode}\n})()`, ctx).map(i => i.json);
}
const FUTURE = new Date(Date.now() + 86400000).toISOString().slice(0, 13) + ':00:00.000Z';
const LATER = new Date(Date.parse(FUTURE) + 3600000).toISOString();
const call = { id: 'twilio-call-CA1', type: 'missed_call', phone: '+12025550101', at: '2026-09-25T10:00:00Z', source: 'twilio-voice' };

test('event -> pending request -> approval -> calendar entry, through the embedded Code nodes', () => {
  const store = {};
  const [p] = runCode('Create pending request', store, [{ body: call }]);
  assert.equal(p.pending.status, 'pending_staff');
  assert.equal(p.pending.drafts[0].status, 'needs_staff_approval');
  assert.equal(runCode('Create pending request', store, [{ body: call }])[0].duplicate, true); // Twilio retry
  const [g] = runCode('Staff approval guard', store, [{ body: { requestKey: 'req-1', revision: 1, approved: true, start: FUTURE, end: LATER } }]);
  assert.equal(g.ok, true);
  assert.equal(store.items['req-1'].status, 'calendar_pending');
  const [r] = runCode('Record calendar result', store, [{ id: 'gcal-event-1' }], { $: () => ({ first: () => ({ json: g }) }) });
  assert.equal(r.ok, true);
  assert.equal(store.items['req-1'].status, 'booked');
  assert.equal(store.items['req-1'].drafts.at(-1).status, 'needs_staff_approval'); // confirmation also waits for staff
});

test('guard rejects: stale revision, not approved, past start, unknown request, second approval, opted out', () => {
  const store = {};
  runCode('Create pending request', store, [{ body: call }]);
  runCode('Create pending request', store, [{ body: { id: 'twilio-msg-SM1', type: 'message', phone: call.phone, text: 'Leak under the sink', at: call.at } }]);
  const guard = d => runCode('Staff approval guard', store, [{ body: { requestKey: 'req-1', approved: true, start: FUTURE, end: LATER, ...d } }])[0];
  assert.match(guard({ revision: 1 }).reason, /revision 1, current is 2/);
  assert.equal(guard({ revision: 2, approved: 'yes' }).reason, 'not approved');
  assert.equal(guard({ revision: 2, start: '2020-01-01T00:00:00Z', end: '2020-01-01T01:00:00Z' }).reason, 'start must be in the future');
  assert.equal(guard({ requestKey: 'req-9', revision: 2 }).reason, 'unknown request');
  assert.equal(guard({ revision: 2 }).ok, true);
  assert.equal(guard({ revision: 2 }).reason, 'request is calendar_pending');
  const s2 = {};
  runCode('Create pending request', s2, [{ body: call }]);
  runCode('Create pending request', s2, [{ body: { id: 'twilio-msg-SM2', type: 'message', phone: call.phone, text: ' stop ', at: call.at } }]);
  assert.equal(s2.items['req-1'].drafts[0].status, 'cancelled');
  assert.equal(runCode('Staff approval guard', s2, [{ body: { requestKey: 'req-1', revision: 1, approved: true, start: FUTURE, end: LATER } }])[0].ok, false);
  assert.equal(runCode('Create pending request', s2, [{ body: { ...call, id: 'twilio-call-CA2' } }])[0].suppressed, 'opted out');
});

test('calendar failure marks the request calendar_failed and drafts nothing', () => {
  const store = {};
  runCode('Create pending request', store, [{ body: call }]);
  const [g] = runCode('Staff approval guard', store, [{ body: { requestKey: 'req-1', revision: 1, approved: true, start: FUTURE, end: LATER } }]);
  const [r] = runCode('Record calendar result', store, [{ error: 'Forbidden' }], { $: () => ({ first: () => ({ json: g }) }) });
  assert.equal(r.ok, false);
  assert.equal(store.items['req-1'].status, 'calendar_failed');
  assert.equal(store.items['req-1'].drafts.length, 1);
});
