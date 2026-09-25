/* backend.js — optional live backend. Demo mode is the default: with `url` empty the page makes no request and the
   simulator runs exactly as before. Set `url` to your deployed Worker's origin (see docs/SETUP-BACKEND.md) and the top
   bar shows whether that Worker answers GET /health with both secrets configured. The Worker never exposes customer
   data to this page; staff work in n8n. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.DeskBackend = api; api.mount(root.document, root.fetch && root.fetch.bind(root)); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const CONFIG = { url: '' }; // e.g. 'https://callback-desk-worker.<your-subdomain>.workers.dev' — leave empty for demo mode

/* Returns { mode: 'demo' } without any request when no URL is set; otherwise asks /health and labels the result. */
async function probe(url, fetchImpl) {
  if (!url) return { mode: 'demo' };
  let origin;
  try { origin = new URL(url); } catch (e) { return { mode: 'live', ok: false, label: 'backend URL is invalid' }; }
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') return { mode: 'live', ok: false, label: 'backend URL must be https' };
  try {
    const res = await fetchImpl(origin.origin + '/health', { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok || body.service !== 'callback-desk-worker') return { mode: 'live', ok: false, label: 'backend answered, but not as Callback Desk' };
    if (!body.configured || !body.configured.twilio || !body.configured.n8n) return { mode: 'live', ok: false, label: 'backend is missing secrets' };
    return { mode: 'live', ok: true, label: 'backend connected' };
  } catch (e) { return { mode: 'live', ok: false, label: 'backend unreachable' }; }
}

function mount(doc, fetchImpl) {
  if (!doc || !CONFIG.url) return; // demo mode: nothing to show, nothing fetched
  const demo = doc.querySelector('.topbar .pill');
  const pill = doc.createElement('span');
  pill.className = 'pill pill-live'; pill.id = 'backend-pill'; pill.setAttribute('role', 'status');
  pill.title = 'Live webhooks go to ' + CONFIG.url + '. The simulator below still replays fictional scenarios.';
  pill.textContent = 'Live · checking';
  if (demo) demo.after(pill);
  probe(CONFIG.url, fetchImpl).then(r => { pill.textContent = 'Live · ' + r.label; pill.dataset.ok = String(!!r.ok); });
}

return { CONFIG, probe, mount };
});
