// pack-data.mjs — regenerates docs/data.js from scenarios.json, config.json and output/transcripts.json
// so the page runs offline and from file:// without fetch. Run after `node demo.js build`.
import fs from 'node:fs'; import path from 'node:path';
const HERE = path.dirname(new URL(import.meta.url).pathname), ROOT = path.resolve(HERE, '..');
const sc = fs.readFileSync(path.join(ROOT, 'scenarios.json'), 'utf8'), cfg = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
const tr = JSON.parse(fs.readFileSync(path.join(ROOT, 'output/transcripts.json'), 'utf8'));
const expected = tr.map(t => { const c = Object.values(t.state.contacts)[0] || {}; const counts = { sms: 0, whatsapp: 0, calendar: 0 }; t.actions.forEach(a => counts[a.kind]++); return { name: t.name, status: c.status, actions: counts, drafts: (c.messages || []).length, revision: c.revision, logLines: t.state.log.length }; });
fs.writeFileSync(path.join(HERE, 'data.js'), `/* data.js — generated from scenarios.json, config.json and output/transcripts.json so the page runs offline and from file://.\n   Regenerate with: node demo.js build && node docs/pack-data.mjs (see README). Do not edit by hand. */\nwindow.DESK_SCENARIOS = ${sc.trim()};\nwindow.DESK_CONFIG = ${cfg.trim()};\nwindow.DESK_EXPECTED = ${JSON.stringify(expected)};\n`);
console.log('docs/data.js written:', expected.length, 'scenario summaries');
