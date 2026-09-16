// check-sim.mjs — proves the page's replay (docs/sim.js + docs/engine.js, the same files the browser loads) reproduces
// every scenario: final status, action counts, drafts and log length must equal both scenarios.json's expected block
// and the transcripts recorded by `node demo.js build`. Also a negative control: a mutated expectation must be caught.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const SIM = require(path.join(HERE, 'sim.js'));
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const scenarios = read('scenarios.json'), config = read('config.json'), transcripts = read('output/transcripts.json');
const bundled = fs.readFileSync(path.join(HERE, 'data.js'), 'utf8');
const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); if (!ok) failed++; };
// 1. the bundled data.js must carry the same scenarios and config the CLI uses (guards against a stale bundle)
const grab = key => JSON.parse(/window\.DESK_(\w+) = ([\s\S]*?);\n/g[Symbol.replace] ? bundled.match(new RegExp(`window\\.DESK_${key} = ([\\s\\S]*?);\\n(?=window\\.|$)`))[1] : '');
check('data.js scenarios == scenarios.json', JSON.stringify(grab('SCENARIOS')) === JSON.stringify(scenarios));
check('data.js config == config.json', JSON.stringify(grab('CONFIG')) === JSON.stringify(config));
// 2. every scenario replays to its expected block and to the recorded transcript
let ok = 0; const bad = [];
scenarios.forEach((s, i) => { const t = transcripts[i]; const c = Object.values(t.state.contacts)[0] || {}; const counts = { sms: 0, whatsapp: 0, calendar: 0 }; t.actions.forEach(a => counts[a.kind]++);
  const r = SIM.checkScenario(s, config, { status: c.status, actions: counts, logLines: t.state.log.length }); if (r.ok) ok++; else bad.push(`${s.name}: ${r.problems.join('; ')}`); });
check(`all ${scenarios.length} scenarios replay to expected + transcripts`, ok === scenarios.length, ok + '/' + scenarios.length + (bad.length ? ' · ' + bad.join(' | ') : ''));
// 3. negative control: a wrong expectation must be reported
const mutated = JSON.parse(JSON.stringify(scenarios[0])); mutated.expected.status = 'opted_out';
check('negative control: mutated expected status is caught', !SIM.checkScenario(mutated, config).ok);
// 4. security property the page demonstrates: a customer-route approve_booking never yields a calendar action
const forged = { channel: 'customer', body: { id: 'forged-1', at: '2025-09-15T10:03:00.000Z', phone: '+12025550101', type: 'approve_booking', approved: true, revision: 1, start: '2025-09-16T10:00:00Z', end: '2025-09-16T11:00:00Z', actor: 'staff' } };
const base = scenarios[0].events.slice(0, 3); const f = SIM.simulate([...base, forged], config);
check('forged customer approval → 0 calendar actions and a guard-no log line', f.actions.filter(a => a.kind === 'calendar').length === 0 && f.log.some(l => l.kind === 'guard-no' && /Rejected event for this actor/.test(l.text)));
console.log(`check-sim · ${new Date().toISOString()} · node ${process.version}`);
for (const [st, name, d] of results) console.log(`${st}  ${name}${d ? '  · ' + d : ''}`);
console.log(failed ? `RESULT: ${failed} FAILED` : 'RESULT: ALL PASS');
process.exit(failed ? 1 : 0);
