# AlphaOS 2.0: the agent runs the floor

Direction set by Yousif 2026-09-29. The agent does the heavy lifting on every
order; humans do three things: QC everything that leaves the building, keep a
clear overview of where orders are and how delayed, and handle exceptions the
agent cannot decide (refunds, complex quotes). Designer capacity balancing is
the agent's job too, with a human override. Nothing in this document goes live
until each gate is flipped explicitly; the framework is built and proven on the
demo environment first. PixArt is the pilot business; every other business
follows as a config, not a rebuild.

## 1. What already exists (verified in this codebase, 2026-09-29)

| Rail | Where | State today |
| --- | --- | --- |
| Etsy order sync | `lib/integrations/etsy` (receipts, oauth, figures, fulfillment) | Live for PixArt, 15 min cadence, driven externally |
| Shopify order sync | `lib/integrations/shopify` (orders, webhooks, fulfillment) | Live via staff-session; webhook plumbing present |
| Buyer messages | `lib/integrations/gmail` + `etsy-mail.ts` | Etsy has no messaging API; buyer messages and sale notices arrive as Etsy notification EMAILS, already parsed into structured facts (kind, receipt id, buyer, cleaned body) and matched to orders by `inbound.ts` |
| Reply understanding | `lib/email/reply-classifier.ts` | Classifies every inbound reply: `approval`, `revision_request`, `question`, `unclear`, with confidence + rationale |
| Reply to action | `lib/email/reply-decisions.ts` | A `revision` decision already re-opens the order with the buyer's own words as the revision reason. Today a human clicks the decision |
| Outbound email | `lib/email/outbox.ts`, `templates.ts`, `dispatch.ts` | Full outbox with templates, suppression, backlog guard |
| Assignment | `lib/orders/assign.ts` + `lib/designers/*` | Capacity, style match, quiet hours all modeled. Today a human triggers it |
| Order pipeline | `orderStatus` enum, `lib/orders/transitions.ts`, `stage-timers.ts` | 13 real stages from `awaiting_photos` to `complete`, with per-stage timers already tracked |
| QC | `lib/qc/*` (checklist, send-guard) | Checklist + pass/fail per order, send-guard before anything leaves |
| Print | `lib/print/*` + `lib/integrations/gelato` + `lib/integrations/lumaprints` | BOTH provider clients exist. Today: reconcile + tracking only (`printMethod` supports `api` and `manual`; nothing is submitted by the app). Lumaprints creds shape + sandbox base already defined |
| VA day view | `lib/orders/today-queue.ts` | Exists; the rework extends it into the single QC queue |

The rework is therefore mostly a driver flip, not a rebuild: the agent pulls
the levers humans pull today, plus two genuinely new builds (print order
submission, the exception inbox).

## 2. Target operating model

One order, eight jobs. Owner after the rework:

1. Intake (Etsy/Shopify -> board card with photos + notes): **agent**
2. Completeness check (photo count vs figures, odd orders): **agent**, mismatch -> exception or a customer email in draft
3. Designer assignment (capacity + style + quiet hours): **agent**, human override always wins
4. Customer email (confirmations, proofs, chasing silence): **agent drafts, VA one-tap approves**; per-template flip to fully automatic later
5. Revision routing (email or Etsy message -> designer board): **agent**
6. Print prep (approved portrait -> ready-to-send provider order): **agent**
7. Submit + track + shipped email: **agent**, after print QC
8. QC (portrait, revision, print-and-ship): **human**, one queue

Humans keep: the QC queue, the overview, the exception inbox, and overrides.

## 3. The flows in detail

### 3.1 Revisions (email or Etsy) -> designer board

- Every buyer reply lands via the Gmail poller. Etsy messages are Etsy
  notification emails, so both channels arrive through one pipe.
- The classifier labels it. At confidence >= threshold, `revision_request`
  auto-applies the existing `reply-decisions` "revision" path: order back to
  `in_design`, revision reason = the buyer's verbatim words, attachments
  carried over, card surfaces on the ASSIGNED designer's board flagged
  "revision" with the original proof beside the request.
- Below threshold, or `unclear`: exception inbox with the agent's best guess
  attached, one tap to confirm or reroute.
- `approval` at confidence: order advances to `approved` and enters print prep.
- The redone proof goes through revision QC (same queue) before it is sent.

### 3.2 Print and ship, prepared not clicked

- On QC-approved: the agent builds the provider order using `lib/print/mapping`
  (product/size/variant -> provider SKU), routing rule per product:
  Lumaprints by default (the majority), Gelato where it wins.
- NEW BUILD: order submission on the existing Lumaprints and Gelato clients
  (today they only read for reconcile). Sandbox first; `printMethod: "api"`.
- The VA's print-and-ship QC card shows in one glance: the print-resolution
  file, product + size, provider + cost, shipping address. One tap = the agent
  submits, watches tracking (existing `tracking.ts` + webhooks), sends the
  shipped email, closes the order. Reconcile stays on as the safety net.

### 3.3 The overview (humans always know where orders are)

- One screen, one line per order: order, business, stage (real
  `orderStatus`), time in stage vs the stage-timer target, delay flag when
  over, assigned designer, next actor. Sort by most-delayed first.
- Drill-down is optional; no QC task ever requires opening a designer board.
- A daily digest line per business: in, out, overdue, exceptions waiting.

### 3.4 The VA day

One Day screen, one queue, three card kinds: portrait QC (buyer photos beside
the finished portrait), revision QC (request beside the redo), print-and-ship
QC (file, size, address, provider). Approve or bounce with a note. Bounces go
back to the designer with the note; nothing else is the VA's job.

### 3.5 Exceptions (the human third)

Refunds, complex quotes, sub-threshold classifications, photo-count mismatches
the customer email couldn't resolve, provider errors. Each item carries full
context plus the agent's suggested answer; resolving one teaches the
threshold.

## 4. Per-business config (not every business has both channels)

Already native: `platform` enum is `etsy | shopify`, shops are per-platform
rows on a business, `orderSource` includes `manual`. A business config =
which channels it has (Etsy only, Shopify only, both), which mailbox, print
provider mix, designer roster, email templates, QC checklist. PixArt proves
the driver; CPS and the rest are configs.

## 5. Safety gates (nothing live until flipped)

- Built and demoed on the demo environment (own Neon db, mock integrations).
- Every outgoing email: draft + one-tap approve, until that template type is
  explicitly flipped to automatic.
- Every print order: sandbox first, then live behind the print QC tap.
- No production credential changes without an explicit yes.
- Production DB rules stand: no mock data, RLS enforced, archived rows never
  count.

## 6. Build order

Ph1 intake + assignment on autopilot -> Ph2 the agent runs the inbox ->
Ph3 print submission + print QC -> Ph4 Day screen + overview + exception inbox
-> Ph5 capacity model + per-business rollout. Deck with per-phase needs:
the plan deck sent 2026-09-29 (var/plan-decks, "AlphaOS 2.0: the agent runs
the floor").
