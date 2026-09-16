/* sim.js — the one replay function shared by the page (app.js) and the Node check (check-sim.mjs).
   It feeds events to engine.js exactly like demo.js does: actor = channel, guards run on every emitted action. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.DeskSim = factory({ bookingEngine: root.bookingEngine, approvalGuard: root.approvalGuard });
})(typeof self !== 'undefined' ? self : this, function (engine) {
'use strict';
const { bookingEngine, approvalGuard } = engine;
const ACTOR = { customer: 'customer', staff: 'staff', adapter: 'adapter', timer: 'timer' };
function classify(text) {
  if (/^(Rejected|Suppressed|Ignored|Request blocked)/.test(text)) return 'guard-no';
  if (/^(SEND|CALENDAR REQUEST)/.test(text)) return 'sim';
  if (/^DRAFT/.test(text)) return 'draft';
  if (/^STAFF/.test(text)) return 'staff';
  if (/^STOP|opted out/i.test(text)) return 'consent';
  if (/^REQUEST/.test(text)) return 'request';
  return 'info';
}
/* Replays events[0..n) from an empty state. Returns the final state, the guarded actions, and an annotated log. */
function simulate(events, config, n) {
  let state = {}; const actions = [], log = [], guards = [];
  const list = n === undefined ? events : events.slice(0, n);
  list.forEach((entry, i) => {
    const event = { ...entry.body, actor: ACTOR[entry.channel] };
    const before = (state.log || []).length;
    let result;
    try { result = bookingEngine(state, event, config); }
    catch (e) { log.push({ i, at: event.at, actor: event.actor, type: event.type, text: 'ENGINE REJECTED: ' + e.message, kind: 'guard-no' }); guards.push({ i, ok: false, text: e.message }); return; }
    state = result.state;
    for (const l of state.log.slice(before)) log.push({ i, at: l.at, actor: event.actor, type: event.type, text: l.text, kind: classify(l.text) });
    for (const a of result.actions) {
      try { approvalGuard(a, state, a.kind === 'calendar' ? 'calendar' : 'message'); actions.push({ ...a, i, ok: true }); guards.push({ i, ok: true, text: `${a.kind} approval matches the current ${a.kind === 'calendar' ? 'request' : 'draft'}` }); }
      catch (e) { guards.push({ i, ok: false, text: e.message }); log.push({ i, at: event.at, actor: event.actor, type: event.type, text: 'GUARD BLOCKED: ' + e.message, kind: 'guard-no' }); }
    }
  });
  return { state, actions, log, guards, count: list.length };
}
function summarize(sim, phone) {
  const c = (sim.state.contacts || {})[phone] || Object.values(sim.state.contacts || {})[0] || {};
  const counts = { sms: 0, whatsapp: 0, calendar: 0 }; sim.actions.forEach(a => counts[a.kind]++);
  return { status: c.status, actions: counts, drafts: (c.messages || []).length, revision: c.revision, escalated: !!c.escalated, logLines: (sim.state.log || []).length };
}
/* Compares one scenario's replay with its expected block (from scenarios.json) and, if given, the recorded transcript summary. */
function checkScenario(s, config, expectedSummary) {
  const sim = simulate(s.events, config); const sum = summarize(sim, '+12025550101'); const problems = [];
  const e = s.expected;
  if (sum.status !== e.status) problems.push(`status ${sum.status} ≠ expected ${e.status}`);
  for (const k of ['sms', 'whatsapp', 'calendar']) if (sum.actions[k] !== e.actions[k]) problems.push(`${k} actions ${sum.actions[k]} ≠ ${e.actions[k]}`);
  if ('drafts' in e && sum.drafts !== e.drafts) problems.push(`drafts ${sum.drafts} ≠ ${e.drafts}`);
  if ('revision' in e && sum.revision !== e.revision) problems.push(`revision ${sum.revision} ≠ ${e.revision}`);
  if ('escalated' in e && sum.escalated !== e.escalated) problems.push(`escalated ${sum.escalated} ≠ ${e.escalated}`);
  if ('escalations' in e && (sim.state.log || []).filter(l => l.text.startsWith('STAFF ESCALATION')).length !== e.escalations) problems.push('escalation count');
  if (e.contains && !(sim.state.log || []).some(l => l.text.includes(e.contains))) problems.push(`log lacks "${e.contains}"`);
  if (expectedSummary) { if (expectedSummary.status !== sum.status) problems.push(`transcript status ${expectedSummary.status} ≠ ${sum.status}`); if (expectedSummary.logLines !== sum.logLines) problems.push(`transcript log lines ${expectedSummary.logLines} ≠ ${sum.logLines}`); for (const k of ['sms', 'whatsapp', 'calendar']) if (expectedSummary.actions[k] !== sum.actions[k]) problems.push(`transcript ${k} ${expectedSummary.actions[k]} ≠ ${sum.actions[k]}`); }
  return { name: s.name, ok: !problems.length, problems, summary: sum, sim };
}
return { simulate, summarize, checkScenario, classify };
});
