# Setting up the live backend

The browser simulator needs none of this: it stays in demo mode unless you complete the steps below. This guide connects a real phone call or WhatsApp message to a staff-approved calendar entry:

```
Twilio (voice number / WhatsApp sandbox)
   │  form-encoded webhook, signed with X-Twilio-Signature
   ▼
Cloudflare Worker  worker/src/index.js
   │  verifies the signature, turns the request into a missed_call or message event,
   │  POSTs JSON with header X-Callback-Desk-Token
   ▼
n8n  worker/n8n/callback-desk-live.json
   Worker intake ──► Create pending request        (one open request per phone, drafts wait for staff)
   Staff decision ─► Staff approval guard ─► Approved? ─► Create calendar event ─► Record calendar result
   Pending requests (GET) ─► list what is waiting
```

The Worker sends nothing and writes no calendar. It only verifies, normalises and forwards. In n8n, a calendar entry is created only after a staff decision that matches the request's current revision. Every customer-facing text, including the first reply and the booking confirmation, is stored as a draft marked `needs_staff_approval`. This milestone has no node that sends messages.

**Status:** the Worker and the n8n export have only been tested locally, with a stub n8n server (`node --test worker/test/*.test.mjs`). Neither has been deployed or imported into a running n8n instance.

## Accounts, by step

| Step | Account needed |
| --- | --- |
| 1. Twilio number and Auth Token | Twilio |
| 2. WhatsApp sandbox join | Twilio, and WhatsApp on the phone you test with |
| 3. n8n instance and workflow import | n8n Cloud, or a server you run n8n on |
| 4. Google Calendar credential | Google account (plus a Google Cloud project if you self-host n8n) |
| 5. Deploy the Worker and set its secrets | Cloudflare |
| 6. Point Twilio at the Worker | Twilio |
| 7. Optional: point the page at the Worker | GitHub (this repository) |
| 8. End-to-end test | all of the above, and a real phone |

Secrets are stored in only two places: Worker secrets (step 5) and n8n credentials (steps 3–4). Never put them in this repository, in `wrangler.toml`, or in the n8n export.

## 1. Twilio number and Auth Token (Twilio account)

1. Sign in to the Twilio Console. A trial account works for testing; check Twilio's trial limits (for example, messages added to calls) before you judge the caller experience.
2. Copy the **Auth Token** from the Console's account info panel. This is the value of the `TWILIO_AUTH_TOKEN` secret in step 5. Keep it out of chat, files and screenshots.
3. Buy or claim a phone number with **Voice** capability. You will set its webhook in step 6.

## 2. WhatsApp sandbox join (Twilio account + WhatsApp on your phone)

1. In the Twilio Console open **Messaging → Try it out → Send a WhatsApp message**. The page shows the sandbox number and a `join <two-words>` code.
2. From the phone you will test with, send `join <two-words>` to the sandbox number on WhatsApp. Twilio replies to confirm.
3. The sandbox only talks to phones that have joined, and a join does not last forever. The sandbox page says how long it lasts, so re-join when it expires.

## 3. n8n instance and workflow import (n8n account or your own server)

1. Open your n8n editor: either n8n Cloud or a self-hosted instance reachable over HTTPS.
2. **Import from File** → `worker/n8n/callback-desk-live.json`. The workflow arrives **inactive**, and every credential slot is named `REPLACE_*`.
3. Generate two unrelated random tokens on your own computer, for example with `openssl rand -hex 32` run twice. One is for the Worker and one is for staff.
4. Create two **Header Auth** credentials in n8n:
   - *Worker token*: Name `X-Callback-Desk-Token`, Value = the first token. Bind it to **Worker intake**.
   - *Staff token*: pick any header name, such as `X-Staff-Token`, and set Value = the second token. Bind it to **Staff decision** and **Pending requests**.
5. Keep the first token for step 5 (`N8N_WEBHOOK_TOKEN`). Give the second one only to the people who approve bookings.
6. Open **Worker intake** and copy its **Production URL**. It ends in `/webhook/callback-desk-intake`, and it is the `N8N_WEBHOOK_URL` secret.
7. The workflow keeps requests in n8n workflow static data. n8n does not save static data in test executions, so run it activated with production URLs. Static data is a prototype store: it has no transactions, no crash recovery and no bounded history (see the README's *Limits before real use*).

## 4. Google Calendar credential (Google account)

1. Create or pick a calendar used only for these bookings, and copy its **Calendar ID** from Google Calendar → Settings → *Integrate calendar*.
2. In n8n create a **Google Calendar OAuth2 API** credential:
   - n8n Cloud: use its *Sign in with Google* button.
   - Self-hosted: create an OAuth client in a Google Cloud project, enable the Google Calendar API, add the redirect URL that n8n shows in the credential dialog, then paste the client ID and secret into n8n.
3. Bind the credential to **Create calendar event**, and replace `REPLACE_CALENDAR_ID` in that node with the Calendar ID.
4. **Activate** the workflow.

## 5. Deploy the Worker and set its secrets (Cloudflare account)

Deploying creates a new Worker in your Cloudflare account. From a clone of this repository:

```sh
cd worker
npx wrangler login
npx wrangler deploy
```

`wrangler deploy` prints the Worker's URL, for example `https://callback-desk-worker.<your-subdomain>.workers.dev`. Until the secrets below exist, the webhook routes answer `503 worker not configured` and forward nothing.

```sh
npx wrangler secret put TWILIO_AUTH_TOKEN     # step 1
npx wrangler secret put N8N_WEBHOOK_URL       # step 3.6
npx wrangler secret put N8N_WEBHOOK_TOKEN     # step 3.3, the Worker token
# optional: ring a staff phone first; only unanswered, busy or failed calls count as missed
npx wrangler secret put FORWARD_TO
```

Each command prompts for the value, so the value never appears in your shell history.

- `wrangler.toml` holds two non-secret settings. `ALLOWED_ORIGIN` is the page origin allowed to read `/health`. `PUBLIC_BASE_URL` must be set only if Twilio calls a custom domain that differs from the URL the Worker sees: Twilio signs the exact URL it calls, so a mismatch rejects every request with 403.
- Check the Worker with `curl https://<worker>/health`. You want `"configured":{"twilio":true,"n8n":true}`. `/health` reports only whether each secret is present, never its value.
- Check that forged requests are refused: `curl -i -X POST -d From=%2B12025550101 -d CallSid=CA0 https://<worker>/twilio/voice` must answer `403 invalid Twilio signature`.

## 6. Point Twilio at the Worker (Twilio account)

1. **Phone number → Voice configuration → A call comes in**: Webhook, `https://<worker>/twilio/voice`, HTTP POST.
2. **WhatsApp sandbox settings → When a message comes in**: `https://<worker>/twilio/whatsapp`, HTTP POST.

What the caller and the sender experience:
- A missed call hears one neutral sentence, and then the call hangs up. It makes no promise of a reply, because any reply is a draft staff must approve.
- A WhatsApp message gets no automatic answer (the TwiML reply is empty).

## 7. Optional: point the page at the Worker (GitHub)

In `docs/backend.js`, set `CONFIG.url` to the Worker URL and publish the page. The top bar then shows `Live · backend connected`, or the reason it is not connected. The simulator below it keeps replaying the fictional scenarios. The Worker exposes no customer data to the page, so staff work in n8n. With `url` left empty, which is the default, the page makes no backend request at all.

## 8. End-to-end test (all accounts + a real phone)

1. Call the Twilio number from your phone and let it ring out (or reject it, if `FORWARD_TO` is set). In n8n, **Executions** should show *Worker intake → Create pending request*, with a `pending_staff` request and a draft that needs approval.
2. Send a WhatsApp message to the sandbox number. The same request gains the message, and its `revision` increases by one.
3. List what is waiting (staff token):

   ```sh
   curl -H "X-Staff-Token: $STAFF_TOKEN" https://<your-n8n>/webhook/callback-desk-pending
   ```

4. Approve the current revision and a time. The calendar entry appears only after this call:

   ```sh
   curl -X POST -H "X-Staff-Token: $STAFF_TOKEN" -H "Content-Type: application/json" \
     -d '{"requestKey":"req-1","revision":2,"approved":true,"start":"2026-10-01T15:00:00Z","end":"2026-10-01T16:00:00Z","summary":"Leak check"}' \
     https://<your-n8n>/webhook/callback-desk-staff
   ```

   If the reply is `ok: false`, it gives the reason: stale revision, not approved, start in the past, unknown request, request already handled, or customer opted out.
5. Send `STOP` on WhatsApp. Pending drafts are cancelled, later approvals for that phone are refused, and later calls from that phone are suppressed.

## Event shape the Worker sends to n8n

It follows the README's customer-intake event contract, plus provenance fields:

```json
{ "id": "twilio-call-CA…", "type": "missed_call", "phone": "+12025550101", "at": "2026-09-25T17:00:00.000Z", "source": "twilio-voice", "dialStatus": "not-forwarded" }
{ "id": "twilio-msg-SM…", "type": "message", "phone": "+12025550101", "text": "…", "at": "…", "source": "twilio-whatsapp", "media": 0 }
```

The `id` is Twilio's own SID, so a provider retry produces the same id, and n8n ignores it the second time. The Worker never sets an `actor`: the route decides who sent an event.

## Not in this milestone

- Sending approved drafts through Twilio. Staff approval of each message is designed for this, but the send step is not built.
- A staff screen. Staff use the two webhooks above.
- A transactional store in place of static data.
