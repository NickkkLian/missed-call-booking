// Writes worker/n8n/callback-desk-live.json from steps.cjs: `node worker/n8n/build-workflow.mjs`.
// The export holds no credentials: every credential slot is a REPLACE_* placeholder you bind after import.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module'; import { createHash } from 'node:crypto';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const steps = createRequire(import.meta.url)('./steps.cjs');
const OUT = path.join(HERE, 'callback-desk-live.json');
const nid = name => createHash('sha1').update('callback-desk-live:' + name).digest('hex').slice(0, 24);

const webhook = (name, pathName, method, cred, pos, responseMode = 'onReceived') => ({
  id: nid(name), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: pos, webhookId: pathName,
  parameters: { httpMethod: method, path: pathName, authentication: 'headerAuth', responseMode, options: {} },
  credentials: { httpHeaderAuth: { id: `REPLACE_${cred}_CREDENTIAL_ID`, name: `REPLACE_${cred}_HEADER_AUTH` } },
});
const code = (name, fn, call, pos) => ({
  id: nid(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', jsCode: `${fn.toString()}\nconst store = $getWorkflowStaticData('global');\nconst now = new Date().toISOString();\nreturn $input.all().map(item => ({ json: ${call} }));` },
});
const respond = (name, pos) => ({ id: nid(name), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: pos, parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} } });

const nodes = [
  { id: nid('Read me'), name: 'Read me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-40, -260], parameters: { width: 520, height: 200, content: '## Callback Desk live path\nWorker intake: the Cloudflare Worker posts verified Twilio events here (Header Auth).\nStaff decision: staff approve a request revision and a time; only then does the calendar node run.\nPending requests: staff list what is waiting.\nNo node sends a message. Drafts wait in static data for staff.\nBind every REPLACE_* credential and the calendar id after import.' } },
  webhook('Worker intake', 'callback-desk-intake', 'POST', 'WORKER', [0, 0]),
  code('Create pending request', steps.createPending, 'createPending(store, item.json.body, now)', [260, 0]),
  webhook('Staff decision', 'callback-desk-staff', 'POST', 'STAFF', [0, 240], 'responseNode'),
  code('Staff approval guard', steps.staffGuard, 'staffGuard(store, item.json.body, now)', [260, 240]),
  { id: nid('Approved?'), name: 'Approved?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [520, 240], parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, combinator: 'and', conditions: [{ id: 'ok', leftValue: '={{ $json.ok }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] }, options: {} } },
  { id: nid('Create calendar event'), name: 'Create calendar event', type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3, position: [780, 160], onError: 'continueRegularOutput',
    parameters: { calendar: { __rl: true, mode: 'id', value: 'REPLACE_CALENDAR_ID' }, start: '={{ $json.start }}', end: '={{ $json.end }}', additionalFields: { summary: '={{ $json.summary }}', description: '={{ "Callback Desk " + $json.requestKey + " for " + $json.phone }}' } },
    credentials: { googleCalendarOAuth2Api: { id: 'REPLACE_GOOGLE_CALENDAR_CREDENTIAL_ID', name: 'REPLACE_GOOGLE_CALENDAR_OAUTH2' } } },
  code('Record calendar result', steps.recordCalendar, "recordCalendar(store, $('Staff approval guard').first().json.requestKey, item.json, now)", [1040, 160]),
  respond('Reply to staff', [1300, 240]),
  webhook('Pending requests', 'callback-desk-pending', 'GET', 'STAFF', [0, 480], 'responseNode'),
  { id: nid('List pending'), name: 'List pending', type: 'n8n-nodes-base.code', typeVersion: 2, position: [260, 480], parameters: { mode: 'runOnceForAllItems', jsCode: "const store = $getWorkflowStaticData('global');\nreturn [{ json: { items: Object.values(store.items || {}).filter(i => ['pending_staff', 'calendar_pending', 'calendar_failed'].includes(i.status) || i.drafts.some(d => d.status === 'needs_staff_approval')) } }];" } },
  respond('Reply with pending', [520, 480]),
];
const link = to => ({ main: [[{ node: to, type: 'main', index: 0 }]] });
const connections = {
  'Worker intake': link('Create pending request'),
  'Staff decision': link('Staff approval guard'),
  'Staff approval guard': link('Approved?'),
  'Approved?': { main: [[{ node: 'Create calendar event', type: 'main', index: 0 }], [{ node: 'Reply to staff', type: 'main', index: 0 }]] },
  'Create calendar event': link('Record calendar result'),
  'Record calendar result': link('Reply to staff'),
  'Pending requests': link('List pending'),
  'List pending': link('Reply with pending'),
};
const workflow = { name: 'Callback Desk - live path (Worker intake, staff approval, Google Calendar)', active: false, nodes, connections, settings: { executionOrder: 'v1', timezone: 'UTC' }, pinData: {}, tags: [] };
fs.writeFileSync(OUT, JSON.stringify(workflow, null, 2) + '\n');
console.log('wrote', path.relative(process.cwd(), OUT), nodes.length, 'nodes');
