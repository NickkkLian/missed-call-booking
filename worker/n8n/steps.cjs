/* The three Code-node steps of the live n8n workflow (worker/n8n/callback-desk-live.json).
   build-workflow.mjs embeds each function verbatim into its Code node; the tests execute the same source.
   `store` is n8n workflow static data. Nothing here sends a message: drafts wait for staff. */

// Event from the Worker -> a pending request (one open request per phone). Deduplicates by event id.
function createPending(store, ev, now) {
  store.items = store.items || {}; store.seen = store.seen || {}; store.seq = store.seq || 0; store.optedOut = store.optedOut || {};
  if (!ev || typeof ev.id !== 'string' || !['missed_call', 'message'].includes(ev.type) || !/^\+[1-9]\d{6,14}$/.test(ev.phone || '')) return { ok: false, reason: 'invalid event' };
  if (store.seen[ev.id]) return { ok: true, duplicate: true, id: ev.id };
  store.seen[ev.id] = now;
  const isStop = ev.type === 'message' && String(ev.text || '').trim().toUpperCase() === 'STOP';
  let item = Object.values(store.items).find(i => i.phone === ev.phone && i.status === 'pending_staff');
  if (isStop) {
    store.optedOut[ev.phone] = now;
    if (item) { item.status = 'opted_out'; for (const d of item.drafts) if (d.status === 'needs_staff_approval') d.status = 'cancelled'; }
    return { ok: true, optedOut: ev.phone };
  }
  if (store.optedOut[ev.phone]) return { ok: true, suppressed: 'opted out', id: ev.id };
  if (!item) {
    const key = 'req-' + (++store.seq);
    item = store.items[key] = { key, phone: ev.phone, status: 'pending_staff', revision: 1, createdAt: now, events: [], drafts: [] };
  } else if (ev.type === 'message') item.revision++; // new customer detail: older approvals no longer match
  item.events.push({ id: ev.id, type: ev.type, at: ev.at, text: ev.type === 'message' ? String(ev.text || '') : undefined });
  if (ev.type === 'missed_call' && !item.drafts.length) {
    item.drafts.push({ id: item.key + '-msg-1', status: 'needs_staff_approval', text: 'Sorry we missed your call. Reply here on WhatsApp with your name, address and what needs fixing, and our team will get back to you. Reply STOP to opt out.' });
  }
  return { ok: true, pending: item };
}

// Staff decision -> an approval for the current revision, or a rejection. Only an approval continues to the calendar node.
function staffGuard(store, d, now) {
  const item = (store.items || {})[d && d.requestKey];
  const no = reason => ({ ok: false, reason, requestKey: d && d.requestKey });
  if (!item) return no('unknown request');
  if (item.status !== 'pending_staff') return no('request is ' + item.status);
  if ((store.optedOut || {})[item.phone]) return no('customer opted out');
  if (d.approved !== true) return no('not approved');
  if (d.revision !== item.revision) return no('approval is for revision ' + d.revision + ', current is ' + item.revision);
  const start = Date.parse(d.start), end = Date.parse(d.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return no('start and end must be ISO times with end after start');
  if (start <= Date.parse(now)) return no('start must be in the future');
  item.status = 'calendar_pending';
  item.approval = { revision: item.revision, start: d.start, end: d.end, at: now };
  return { ok: true, requestKey: item.key, phone: item.phone, start: d.start, end: d.end, summary: String(d.summary || 'Callback Desk booking ' + item.key).slice(0, 120) };
}

// Calendar node output -> booked, plus a confirmation draft that staff must approve before it is sent.
function recordCalendar(store, requestKey, calendarEvent, now) {
  const item = (store.items || {})[requestKey];
  if (!item || item.status !== 'calendar_pending') return { ok: false, reason: 'no calendar-pending request ' + requestKey };
  if (!calendarEvent || !calendarEvent.id) { item.status = 'calendar_failed'; return { ok: false, reason: 'calendar returned no event id', requestKey }; }
  item.status = 'booked'; item.calendarEventId = calendarEvent.id; item.bookedAt = now;
  item.drafts.push({ id: item.key + '-msg-' + (item.drafts.length + 1), status: 'needs_staff_approval', text: 'You are booked for ' + item.approval.start + '. Reply STOP to opt out.' });
  return { ok: true, requestKey, calendarEventId: calendarEvent.id, status: item.status };
}

if (typeof module === 'object' && module.exports) module.exports = { createPending, staffGuard, recordCalendar };
