# Callback Desk

**Turn missed calls into bookings — staff approve every message and every calendar write.**

A missed call creates an SMS draft that points the customer to WhatsApp intake. Structured details become a booking request. Staff approve the current request before a calendar action can run, and only an authenticated success receipt produces a confirmation draft — which staff approve again. Nothing goes out on its own.

> **This is an offline n8n template with fictional customer records, plus a browser simulator that runs the same state machine.** It has not been imported into a running n8n instance. Provider integrations are adapter placeholders. It is not a deployed customer service.

[![Check](https://img.shields.io/github/actions/workflow/status/NickkkLian/missed-call-booking/check.yml?branch=main&label=check&style=flat-square&labelColor=2f5859)](https://github.com/NickkkLian/missed-call-booking/actions/workflows/check.yml)

![Callback Desk console: the customer's phone, the staff desk with a draft awaiting approval, and the state card with the last guard decision](docs/screenshot-console.png)

## Try it

**In the browser** — open the [live simulator](https://nickkklian.github.io/missed-call-booking/) (static, no server; the only network requests are its web fonts) or `docs/index.html` from a clone. *Replay* steps through any of the 22 scenarios one event at a time; *Play as customer & staff* lets you call, text, send the intake form, approve drafts, pick a calendar slot, simulate the adapter receipt, advance the clock, and try the three attacks the guard exists for (a forged approval on the customer route, a replayed approval, a STOP with an old timestamp). The scenarios page replays all 22 in your tab and shows whether each matches its expected outcome.

**From the command line** — tested with Node.js 24 on macOS; CI runs Node 22 on Ubuntu, Windows and macOS. No packages, services, credentials or internet connection are needed.

```sh
node demo.js build
node demo.js check
```

The build prints every conversation and final state. [scenarios.json](scenarios.json) contains the events and explicit expected outcomes. [output/transcripts.json](output/transcripts.json) preserves the full replay. Expected check result: `CHECK PASS 22/22 scenarios`.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"darkMode": false, "fontFamily": "Inter, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Helvetica, Arial", "primaryColor": "#dae7db", "mainBkg": "#dae7db", "primaryTextColor": "#1d1b24", "nodeTextColor": "#1d1b24", "textColor": "#1d1b24", "primaryBorderColor": "#2f5859", "nodeBorder": "#2f5859", "secondaryColor": "#fae8eb", "tertiaryColor": "#f7e9e8", "lineColor": "#5f7f76", "arrowheadColor": "#5f7f76", "defaultLinkColor": "#5f7f76", "edgeLabelBackground": "#fae8eb", "clusterBkg": "#f7e9e8", "clusterBorder": "#a8707a", "titleColor": "#7d2d44"}}}%%
flowchart TD
    Call[Missed call] --> Dedupe[Check duplicate and STOP state]
    Dedupe --> Draft[SMS draft with WhatsApp link]
    Draft --> StaffSMS[Staff approves message]
    StaffSMS --> SMS[Simulated SMS]
    SMS --> Intake[WhatsApp form or structured intake]
    Intake --> Validate[Validate address, postal code and service area]
    Validate --> Request[Booking request with revision]
    Request --> StaffBooking[Staff approves revision and time]
    StaffBooking --> Guard[Verify approval against current request]
    Guard --> Calendar[Simulated calendar action]
    Calendar --> Receipt[Authenticated success receipt]
    Receipt --> Confirm[Confirmation draft]
    Confirm --> StaffConfirm[Staff approves message]
    StaffConfirm --> Reply[Simulated WhatsApp confirmation]
    Request --> Escalate[Internal escalation after timeout]
    SMS --> Reminder[At most one reminder draft, then stop]
    Intake --> Stop[STOP cancels pending messages]
```

All outbound messages, including the first SMS and reminders, require a separate staff decision. Preparing the request is automatic; sending it is gated.

## The simulator

![Play mode after a full conversation: SMS and WhatsApp threads, a booked request with its booking key, and the guard rejecting a forged approval](docs/screenshot-play.png)

- **One state machine, three places.** `engine.js` is embedded verbatim in the n8n export's Code nodes, executed by the CLI checker, and loaded by the page. `docs/sim.js` feeds events to it exactly the way `demo.js` does; `docs/check-sim.mjs` proves in CI that the page's replay reproduces all 22 recorded transcripts and that `docs/engine.js` is byte-identical to `engine.js`.
- **The guard is on screen.** The state card always shows the last guard decision — an approval that matches the current request, or `⊘ Rejected event for this actor` when the customer route tries to approve a booking. Rejections are the product working, so they are shown in the log, not as errors.
- **Everything simulated says so.** Sent messages carry `sent (simulated)`, calendar blocks carry the `bookingKey` and `simulated`, and the adapter receipt in Play mode is a button you press, not something the page fabricates.
- **Config** exposes the single business-variable block (hours, days, timezone, service-area prefixes, reminder/stop/escalation minutes); read-only adapter fields explain why they are read-only. Replays and the scenario checks always use the defaults from `config.json`.
- Dark and light themes, 375 px layout with Customer / Staff / Calendar tabs, keyboard stepping (→ / ←), shareable URLs (`#/console?scenario=forged_customer_approval&mode=replay&step=3`).

## Import and configure

1. In an n8n editor, create a workflow and use **Import from File** to select [workflow.json](workflow.json). The export is inactive and uses built-in nodes: Manual Trigger, Webhook, Schedule Trigger, Code, If, HTTP Request and Sticky Note. Import compatibility still needs a real n8n check.
2. Keep `dryRun: true`. Run **Manual demo**. This replays a full conversation in one execution, uses isolated state, and emits no outbound HTTP actions. Read **Review queue** for the transcript and simulated actions.
3. **Business configuration** is the single variable block: business hours/days/timezone, service postal prefixes, duplicate window, reminder/stop intervals, escalation interval, test WhatsApp number and adapter base URL. The local builder takes the same values from `config.json`. Defaults use UTC and an example service-area configuration. Change local config/source and run `build` to regenerate the JSON; do not edit generated Code nodes independently.
4. For sandbox webhook experiments, create three different Header Auth credentials: customer-provider ingress, staff decisions, and calendar-adapter receipts. Bind them to the matching placeholder credential slots. The fourth credential authenticates outgoing requests to an adapter. Never put secrets into the exported JSON. n8n supports authenticated webhook nodes; see its [Webhook documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).
5. Send events in the shape shown below. Customer payloads cannot choose their actor: each authenticated route overwrites it and restricts permitted event types. The staff route must be reachable only by the staff tool. Customer-provider adapters must validate provider signatures and bind the phone to the sender; this template does not implement provider-specific verification.
6. The timer uses one-minute ticks. Multi-execution prototype state uses workflow static data. n8n documents that static data is not saved in test executions and can be unreliable with frequent executions. The single-run manual demo avoids depending on persistence. See [n8n's static-data reference](https://github.com/n8n-io/n8n-docs/blob/main/docs/build/code-in-n8n/cookbook/built-in-methods-and-variables-examples/getworkflowstaticdata.md).

### Accounts needed for a future integration

- An n8n workspace or self-hosted instance.
- A telephony/SMS account providing missed-call events and SMS delivery.
- A WhatsApp Business messaging account and a form or structured intake adapter.
- A calendar account with write access restricted to the intended calendar.
- An authenticated staff review interface and a durable queue/database for production state.

**Costs: check with your service providers.**

### Event contract

The offline event wrapper is `{ "channel": "customer", "body": { ... } }`. Webhooks receive only `body`, assign the actor from their route and assign the receipt timestamp themselves. Keep each event ID unique and stable across provider retries.

| Route | Allowed events | Required additional fields |
| --- | --- | --- |
| Customer intake | `missed_call` | `id`, `phone` |
| Customer intake | `message` | `id`, `phone`, `text`; case-insensitive trimmed `STOP` opts out |
| Customer intake | `details` | `id`, `phone`, `details` with name, issue, address, postal, preference (`callback` or `visit`) |
| Staff decisions | `approve_message` | `id`, `phone`, `messageId` from Review queue, `approved: true` |
| Staff decisions | `approve_booking` | `id`, `phone`, current `revision`, `approved: true`, future ISO `start` and `end` |
| Calendar receipts | `calendar_result` | `id`, `phone`, `bookingKey`, `success`, and a nonempty `providerEventId` on success |

Example structured details for a fictional customer. Postal codes `K1A 0B1` and `H0H 0H0` in the fixtures are public format examples that may be assigned in the real world; they are not claimed to be fictional or tied to the example customer/address. Names, issues and customer records are invented, and phone numbers use the reserved test range.

```json
{
  "id": "intake-example-01",
  "type": "details",
  "phone": "+12025550101",
  "details": {
    "name": "Test Customer 01",
    "issue": "Synthetic leaking fixture",
    "address": "123 Example Road",
    "postal": "K1A 0B1",
    "preference": "visit"
  }
}
```

There is no natural-language agent in this demo. A WhatsApp form/adapter must collect these fields, or staff can enter them. A plain-text message creates a receipt log entry and is never silently interpreted as a booking; no case-insensitive fragment of 20 or more characters from the message body is copied into that log entry.

## Failure handling

| Situation | Behaviour covered by the simulator |
| --- | --- |
| Repeated missed calls | Suppress repeats within five minutes; retain an already-open conversation even after the window |
| Plain-text booking request | Log receipt with an internal instruction to collect structured intake; keep request revision at zero and create no booking or outbound message |
| Customer never replies | One reminder draft after 30 minutes from the approved initial message; stop at 90 minutes; an expired reminder approval cannot send |
| Customer says STOP | Persist opt-out and cancel queued messages; later missed calls and staff approvals cannot re-enable contact |
| Outside business hours | First draft states that staff will review when open; it does not promise emergency coverage |
| Staff does not confirm | Add one internal escalation after 45 minutes; no calendar action occurs |
| Invalid address/postal code | Block the request and draft a clarification; format checking is not geocoding |
| Outside service area | Reject a postal prefix outside the configured list |
| Details change after review | Increment request revision; old approvals fail |
| Repeated approval | One calendar action per accepted revision in serial state; repeat event IDs and later repeated approval requests do not create another action |
| Calendar write fails | Mark staff action required; do not draft customer confirmation |
| Forged approval in customer input | Reject the event type and ignore user-supplied actor fields |
| STOP arrives with an old timestamp | Apply opt-out before ordinary event ordering checks |

Callbacks still require address/postal details in this demonstration because eligibility is checked before either service preference. Staff select the time; customer messages do not reserve calendar capacity.

### Scenario coverage

Which of the 22 scenarios exercise each event type, route and final state. This table is generated from the fixtures and `check` fails if it drifts from them.

<!-- coverage:start -->
| Event type | Scenarios | Count |
| --- | --- | ---: |
| `missed_call` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22 | 22 |
| `message` | 5, 7, 8, 19, 21 | 5 |
| `details` | 1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21 | 13 |
| `approve_message` | 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 | 20 |
| `approve_booking` | 1, 2, 11, 12, 13, 14, 15, 16, 17, 18, 19 | 11 |
| `calendar_result` | 1, 2, 18 | 3 |
| `tick` | 6, 7, 8, 10, 20, 22 | 6 |

| Route | Scenarios | Count |
| --- | --- | ---: |
| customer | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22 | 22 |
| staff | 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21 | 20 |
| adapter | 1, 2, 18 | 3 |
| timer | 6, 7, 8, 10, 20, 22 | 6 |

| Final status | Scenarios | Count |
| --- | --- | ---: |
| `booked` | 1, 2 | 2 |
| `calendar_pending` | 15 | 1 |
| `calendar_failed` | 18 | 1 |
| `awaiting_staff` | 10, 14, 16, 17 | 4 |
| `needs_details` | 11, 12, 13 | 3 |
| `waiting_customer` | 3, 4, 5, 9, 22 | 5 |
| `closed_no_reply` | 6, 20 | 2 |
| `opted_out` | 7, 8, 19, 21 | 4 |

Scenario numbers follow `scenarios.json` order (1–22). Generated by `node demo.js coverage`; `check` fails if this table and the README drift apart.
<!-- coverage:end -->

## Check the guard, including a broken workflow

```sh
node demo.js check
node demo.js break
node demo.js coverage
node docs/check-sim.mjs
```

The checker verifies connection sources/targets, 26 node contracts, five entry points, credentials/test-number defaults and graph reachability. Removing **Staff booking guard** makes **Write calendar** and **Calendar simulated** unreachable; removing **Staff message guard** makes **Send message** and **Message simulated** unreachable. It also executes the actual embedded guard with a forged action, verifies that the customer route rejects booking approvals, asserts that a plain-text customer's message body is absent from the receipt log, runs all 22 scenarios against the actual embedded state-machine code comparing saved transcripts with fresh results, and checks that the coverage table above matches the fixtures.

`break` tests three separate mutations in temporary copies inside this demo folder:

| Mutation | Required failure from the real checker |
| --- | --- |
| Add Customer intake -> Write calendar | `FAIL: approval bypass reaches Write calendar` |
| Replace the approval guard with a no-op, then rebuild | `FAIL: Missing expected exception: Staff booking guard accepted forged calendar action` |
| Allow `approve_booking` on the customer route, then rebuild | `FAIL: Missing expected exception: Customer intake route accepted approve_booking event` |

Each checker process must exit 1. The demonstration command returns 0 only after observing all three specific failures, and removes its temporary copies; the original source and export stay intact. Process creation and write access to this demo folder are required.

`docs/check-sim.mjs` (Node 22+) replays every scenario through the page's own `docs/sim.js` and `docs/engine.js`, compares final status, action counts, drafts and log length with `scenarios.json` and `output/transcripts.json`, confirms `docs/data.js` is a fresh bundle of the fixtures, includes a negative control (a mutated expectation must be caught), and asserts that a customer-route approval never produces a calendar action. The included `.gitattributes` keeps source and generated JSON at LF under `core.autocrlf=true`, because the export embeds and compares the state-machine source exactly.

## Limits before real use

- The supplied workflow stays in dry-run mode and accepts only reserved North American `555-01xx` test numbers. NANPA describes that reservation in [555 line numbers](https://nanpa.com/numbering/555-line-numbers). The WhatsApp link illustrates routing; the fictional number has no live account.
- The HTTP nodes describe adapter contracts at `https://adapter.invalid/calendar` and `/message`; no provider adapter is included. The message adapter must route by action kind and enforce approved WhatsApp templates/windows, consent and sender identity. Those provider policies were not exercised here.
- A calendar adapter must deduplicate by `bookingKey`, verify availability and send an authenticated success/failure receipt. Message adapters must deduplicate by `messageId` within their deployment. Delivery failures go to a staff-action output, with retries disabled. A timeout is an unknown outcome until reconciled with the provider.
- `sent_simulated` records an approved dispatch, not proof of provider delivery. No success receipt is fabricated. The offline normal scenario supplies its own clearly synthetic receipt; in the browser's Play mode the receipt is a button the user presses.
- Static data does not provide atomic concurrency, crash recovery, durable opt-outs or a bounded history. Before real use, replace it with a transactional state/outbox store and recheck consent/revision at dispatch time. Serial tests do not prove that STOP and an in-flight request cannot race. Stopping contact does not automatically delete an already-created calendar event.
- The internal escalation is visible in Review queue; external staff notifications and the staff interface are integration work. The current export cannot be presented as a turnkey live service.
- Address syntax and postal prefixes do not prove an address exists. There is no geocoding, availability solver, appointment cancellation/rescheduling or emergency triage. Do not use this for urgent repairs that need a human dispatcher.
- The browser simulator has not been imported into n8n either; it demonstrates the state machine and the approval gate, not the n8n runtime. Play sessions are not saved. The calendar grid is drawn in the configured timezone's hours but positioned on UTC days.

## Repository layout

```
engine.js               the state machine + approval guard (also embedded in workflow.json)
demo.js                 CLI: build / check / break / simulate / coverage (Node 22+, no packages)
config.json             the single business-variable block
scenarios.json          22 scenarios with events and expected outcomes (generated by build)
workflow.json           the n8n export (generated by build)
output/transcripts.json full replay of every scenario (generated by build)
docs/index.html         the browser simulator (GitHub Pages root)
docs/sim.js             replay core shared by the page and docs/check-sim.mjs
docs/engine.js          byte-identical copy of engine.js (CI asserts it)
docs/data.js            bundled fixtures, regenerated by docs/pack-data.mjs
docs/design-tokens.css  shared design tokens (light and dark)
```

MIT licensed. Copyright 2026 Nick Lian.
