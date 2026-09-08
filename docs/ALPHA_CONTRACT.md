# Alpha contract (AlphaOS <-> Alpha AI)

Alpha AI is the manager that runs on the company daemon, on its own number.
AlphaOS talks to it through ONE module: `lib/alpha/client.ts`.

- `sendAlphaEvent(tx, evt)`: queues a row in `alpha_events` (status `queued`)
  and best-effort POSTs it to `ALPHA_HOOK_URL/alpha/event`. The daemon also
  polls `GET /api/alpha/events?status=queued` (to be added by the daemon lane)
  and marks rows delivered, so nothing is lost when the hook is down.
- `askAlpha(q)`: synchronous POST to `ALPHA_HOOK_URL/alpha/ask`, 60 s. Returns
  `{ answer, ruleId, escalated, connected }`. With no hook configured it
  returns a calm fallback and `connected: false`; UI must render that as a
  normal answer, never an error.

Event types and who sends them:

| type | sender | to |
|---|---|---|
| designer.brief | assignment (auto or manual) | designer |
| designer.nudge | SLA sweep at 24 h | designer |
| designer.reassigned | SLA sweep at 48 h | both designers + VA |
| designer.qc_feedback | QC fail | designer |
| va.attention | anything a VA must look at now | va |
| customer.silent | reminders sweep | va |
| order.missed_print | print reconciliation | va + admin |
| owner.rundown | daily | admin |
| owner.question | askAlpha escalation | admin |

Rules: the row's `text` is the human-readable message in plain English, no
house lingo. `payload` carries ids and links (`{ orderUrl, uploadUrl }`).
Never put customer email or full names in a designer-bound event.
