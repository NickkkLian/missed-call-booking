/* Callback Desk webhook Worker.
   Twilio (voice or WhatsApp sandbox) -> this Worker -> n8n webhook. Nothing here sends a message or writes a calendar:
   the Worker only verifies, normalises and forwards. Staff approve every outbound message and calendar entry in n8n.

   Secrets (set with `wrangler secret put`, never committed):
     TWILIO_AUTH_TOKEN   verifies X-Twilio-Signature
     N8N_WEBHOOK_URL     the n8n "Callback Desk intake" production webhook URL
     N8N_WEBHOOK_TOKEN   value of the header n8n's Header Auth credential expects
   Optional:
     PUBLIC_BASE_URL     the https origin Twilio is configured with, if it differs from what the Worker sees
     FORWARD_TO          number to ring first; if unset every inbound call is treated as missed
     ALLOWED_ORIGIN      origin allowed to read GET /health (the demo page), default none */

export const N8N_TOKEN_HEADER = 'X-Callback-Desk-Token';
const MISSED_DIAL_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

/* Twilio's scheme: base64(HMAC-SHA1(authToken, url + concat(sorted POST keys, each key immediately followed by its value))). */
export async function twilioSignature(authToken, url, params) {
  // Repeated keys: each value is appended as key+value, values sorted (as Twilio's own helper library does).
  const keys = [...new Set(params.keys())].sort();
  const data = url + keys.map(k => [...new Set(params.getAll(k))].sort().map(v => k + v).join('')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  let bin = ''; for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyTwilio(request, params, env) {
  const given = request.headers.get('X-Twilio-Signature');
  if (!given || !env.TWILIO_AUTH_TOKEN) return false;
  const u = new URL(request.url);
  const url = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/+$/, '') + u.pathname + u.search : request.url;
  return timingSafeEqual(given, await twilioSignature(env.TWILIO_AUTH_TOKEN, url, params));
}

const stripChannel = addr => String(addr || '').replace(/^whatsapp:/, '');
const e164 = p => /^\+[1-9]\d{6,14}$/.test(p);

/* Event bodies follow the README's event contract (customer intake route): the id is the Twilio SID so provider
   retries stay deduplicated; the actor is never taken from the request. */
export function normaliseCall(params, receivedAt) {
  const phone = params.get('From'), sid = params.get('CallSid');
  if (!sid || !e164(phone)) return null;
  return { id: 'twilio-call-' + sid, type: 'missed_call', phone, at: receivedAt, source: 'twilio-voice', dialStatus: params.get('DialCallStatus') || 'not-forwarded' };
}

export function normaliseWhatsApp(params, receivedAt) {
  const phone = stripChannel(params.get('From')), sid = params.get('MessageSid') || params.get('SmsMessageSid');
  if (!sid || !e164(phone) || !String(params.get('From')).startsWith('whatsapp:')) return null;
  return { id: 'twilio-msg-' + sid, type: 'message', phone, text: String(params.get('Body') || ''), at: receivedAt, source: 'twilio-whatsapp', media: Number(params.get('NumMedia') || 0) };
}

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const twiml = inner => new Response('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>', { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

/* The caller hears a neutral line: no promise of a reply, because any reply is a draft staff must approve. */
const MISSED_TWIML = '<Say>Sorry we missed your call. Our team will review it during business hours.</Say><Hangup/>';

export async function forward(event, env) {
  const res = await fetch(env.N8N_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [N8N_TOKEN_HEADER]: env.N8N_WEBHOOK_TOKEN }, body: JSON.stringify(event) });
  if (!res.ok) throw new Error('n8n responded ' + res.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (env.ALLOWED_ORIGIN && request.headers.get('Origin') === env.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN;
      // Reports only whether each secret is present, never its value.
      return new Response(JSON.stringify({ service: 'callback-desk-worker', ok: true, configured: { twilio: !!env.TWILIO_AUTH_TOKEN, n8n: !!(env.N8N_WEBHOOK_URL && env.N8N_WEBHOOK_TOKEN) } }), { headers });
    }
    const route = { '/twilio/voice': 'voice', '/twilio/whatsapp': 'whatsapp' }[url.pathname];
    if (!route) return text(404, 'not found');
    if (request.method !== 'POST') return text(405, 'method not allowed');
    if (!(request.headers.get('Content-Type') || '').includes('application/x-www-form-urlencoded')) return text(415, 'expected form-encoded Twilio webhook');
    if (!env.TWILIO_AUTH_TOKEN || !env.N8N_WEBHOOK_URL || !env.N8N_WEBHOOK_TOKEN) return text(503, 'worker not configured');
    const params = new URLSearchParams(await request.text());
    if (!(await verifyTwilio(request, params, env))) return text(403, 'invalid Twilio signature');
    const receivedAt = new Date().toISOString();

    if (route === 'voice') {
      const dial = params.get('DialCallStatus');
      if (!dial && env.FORWARD_TO) {
        // First leg: ring staff. Twilio posts the outcome back here with DialCallStatus.
        return twiml('<Dial timeout="20" action="' + xml(url.pathname) + '" method="POST">' + xml(env.FORWARD_TO) + '</Dial>');
      }
      if (dial && !MISSED_DIAL_STATUSES.has(dial)) return twiml('<Hangup/>'); // answered: not a missed call
      const event = normaliseCall(params, receivedAt);
      if (!event) return text(400, 'missing CallSid or From');
      try { await forward(event, env); } catch (e) { return text(502, 'could not reach n8n'); }
      return twiml(MISSED_TWIML);
    }

    const event = normaliseWhatsApp(params, receivedAt);
    if (!event) return text(400, 'missing MessageSid or whatsapp: From');
    try { await forward(event, env); } catch (e) { return text(502, 'could not reach n8n'); }
    return twiml(''); // no automatic reply: staff approve every outbound message
  },
};
