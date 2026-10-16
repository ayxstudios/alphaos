# No limbo

> Yousif, 2026-10-14: "There shouldn't ever be anything unassigned. You should be
> able to clear it if it's not needed or gather the information and action it
> either by sending it to a designer or letting me know. This should be across
> all of AlphaOS."

There are no VAs any more, so nothing may wait for a human to notice it.

## The invariant

Every live order (not archived; status not cancelled / complete / delivered /
shipped) and every open exception is OWNED, at all times, by one of:

1. **A designer.** The order has an active assignment (a human designer or AI
   Studio). `ready_to_assign` WITH an active assignment is that designer's
   queue: assigned, not started. It is never "unassigned".
2. **The buyer, with a live chase.** `awaiting_photos` with a reachable contact
   and a photo request or reminder in the last 7 days. `awaiting_details` for
   under 2 hours while the automatic gatherers run (intake re-parses every
   tick; the Etsy buyer-email filler runs every 30 minutes). When the only
   gap is the buyer's email, the filler owns it for 12 hours: it reads the
   address off the Etsy order page, and a desk busy with buyer replies can
   take hours to give it a turn. Nobody is asked for an email the filler can
   read (Yousif 2026-10-13).
3. **Cleared.** Not needed: spam and vendor mail, exceptions whose problem is
   gone, cancelled orders. Closed automatically with a reason.
4. **Yousif.** Raised on the Alpha line with what is stuck and a
   recommendation: an open exception with `detail.escalatedAt` set.

`fulfillment_only` orders (add-ons, never designed) are owned while linked to a
live parent order.

Anything else is limbo, and the next agent tick moves it into 1 to 4.

## Contract between the pieces

Anything that needs Yousif is an OPEN `exceptions` row with:

- `summary`: one plain line, what is stuck ("can't tell how many people are in
  the portrait")
- `detail.recommendation`: one plain line, what I would do ("ask the buyer
  how many people", "give it to Jerome")

Whoever finds the problem opens the row. The owner digest (L5) sends every open
row that the auto-close (L1) did not close once its kind's grace has passed.
Nothing else talks to Yousif about limbo.

## L1 Stale exceptions close themselves (lib/agent/limbo.ts)

Resolve with `resolved_by = null`, `resolution_note = "auto: <reason>"`, and an
activity_log row `agent.exception_auto_closed` {exceptionId, kind, reason}.

Any kind: the order is archived, or its status is cancelled / complete /
delivered / shipped ("order closed").

| kind | also closes when |
| --- | --- |
| no_eligible_designer | the order has an active assignment, or is no longer `ready_to_assign` |
| ai_designer_failed | a non-agent designer holds the order, or it is past `in_design` |
| photo_count_mismatch | the order has an active assignment or is past `ready_to_assign` (it went to design with the photos it had) |
| intake_unparsed, legacy_order | the order left `awaiting_details` / `triage` and `needs_review` is false |
| new_product | the card is per PRODUCT: its style is no longer `auto_created` (someone mapped it), or EVERY order in `detail.orderIds` (plus the card's own order) is closed or has left `awaiting_details` / `triage`. One held order keeps the card open. |
| addon_only | the order is `fulfillment_only` (linked) or has an active assignment |
| reply_unclear, buyer_question | a customer email for that order was sent after the exception opened |
| email_send_failed | that message has since been sent, or a later email to the same customer went out |
| unmatched_reply | see L2 |
| anything else | only the "order closed" rule |

## L2 Junk mail is cleared, not queued

Unmatched mail (an open `unmatched_reply`, and new mail in the inbox pass
BEFORE an `unmatched_reply` is opened) goes through:

1. **Match first.** Sender address = a customer's email in that business, or an
   order number of ours in the subject/body: attach it to that order the way
   the inbox pass handles a matched reply, close "auto: matched to <order>".
2. **Junk.** A pure `classifyUnmatchedMail({from, subject, excerpt})` returns
   `customer | junk | unsure` with a reason. Junk is closed "auto: not a
   customer (<reason>)" and the EXACT sender address goes into
   `email_sender_ignores` for that business so it never comes back. Never a
   whole domain, never a free-mail domain.
   Junk signals: brand impersonation (Shopify, Meta/Facebook/Instagram, Etsy,
   PayPal, Google, Apple/TestFlight, OpenAI, Stripe, Amazon, or misspellings
   like "Shoplfy") from a domain that is not that company's; phishing and
   vendor phrases (verify your store, KYC, suspended / restricted account,
   policy violation, remove negative reviews, affiliate, partnership or
   sponsorship pitch, SEO, backlinks, guest post, marketing / web design
   services, grow your store, funding / loan); bulk and notification senders
   (no-reply, notifications, newsletters, pinterest.com, vistaprint.com and
   similar) that do not name one of our orders.
3. **Unsure** (including mailer-daemon bounces) stays open for L5 with a
   recommendation.

## L3 Assignment never parks (assignStep + lib/orders/assign.ts)

The 4 hour no-designer wait goes. When `runAutoAssign` finds nobody:

- **Everyone who draws the style is at a limit** (daily cap, style quota):
  overflow to the style's main designer. Eligible: draws the style, active,
  not AI Studio (`is_agent`), `daily_capacity >= 2` (0 is paused, 1 is a
  deliberate throttle; neither ever gets overflow), under `max_active_orders`
  when that is set. Pick the highest `daily_capacity`, then rank, then the
  shortest not-started queue. The designer's due date moves out by her queue:
  `SLA + 24h * floor(not_started_queue / daily_capacity)`. `orders.due_at`
  never moves. Activity `agent.assigned` with `overflow: true`.
- When that designer's not-started queue passes 3 days of her cap, one
  `designer_backlog` line per style per Sydney day: "Mar has 46 cartoon orders
  waiting, about 3 days at 15 a day" / "raise her daily limit or add a second
  cartoon designer".
- **Nobody draws the style, or the style is unknown**: open
  `no_eligible_designer` at once with the closest style and its main designer
  as the recommendation (or "map <product> to a style").
- **Add-on only**: find the buyer's portrait order (same business and
  customer, not an add-on, still open, placed within 30 days). Exactly one
  → the add-on becomes `fulfillment_only`, linked on both orders,
  `addon_only` closes. None or several → `addon_only` with the candidates in
  the recommendation.
- AI Studio never gets Disney or cartoon pets, and overflow never goes to AI
  Studio.

## L4 Waiting states are watched (lib/agent/limbo.ts)

A row (existing exception refreshed, or a new `stuck_order`) for:

- `awaiting_details` or `triage` for over 2 hours (12 hours when there is
  no buyer email yet): what is missing (buyer email, figure count, style, not
  in AlphaOS) and what I would do.
- `needs_review` for over 2 hours.
- `awaiting_photos` with no reachable contact for over 12 hours, or no photos 7
  days after the last reminder.
- `fulfillment_only` with no live parent for over 24 hours.
- `ready_to_assign` with no designer that the agent may not auto-assign
  (legacy, before `agentFrom`) for over 2 hours.

## L5 Owner digest (lib/agent/owner-digest.ts)

- Recipient: `businesses.agent_config.ownerUserId` (new optional key; set to
  Yousif's admin user for every business). The event goes out with
  `toUserId` = that user, which the events API turns into `toName` and the
  daemon delivers to that person only. Unset = `toRole: "admin"` (every owner).
- At most ONE `owner.question` Alpha event per recipient per 60 minutes, across
  every business (the last one is found in `alpha_events` by type
  `owner.question` and `payload.source = "no_limbo"`).
- Items: open exceptions L1 did not close, past their grace, not raised in the
  last 24 hours, raised at most 3 times. Grace: no_eligible_designer,
  addon_only, stuck_order, designer_backlog 0; reply_unclear, buyer_question,
  unmatched_reply, ai_designer_failed 1h; email_send_failed, intake_unparsed,
  legacy_order, new_product 2h; an intake row whose only gap is an unread
  buyer email 12h (the filler's window, worded as what I tried, never "Etsy
  did not share it"); photo_count_mismatch never (the buyer is
  inside the 72h shortfall window; the assigner proceeds after it).
- Text: "AlphaOS needs you (N)" then one dot line each: "• <shop> <order no>:
  <summary>. <recommendation> <link>". Max 8 lines, then "+N more: <link>".
  Plain words: no "exception", "agent", "tick", "kind", no em dashes.
- Stamps `detail.escalatedAt` and `detail.escalations` in the same
  transaction as the event.

## L6 Census

`getLimboCensus()` per business: with a designer, waiting on the buyer,
raised to Yousif, limbo (target 0), and the limbo order numbers. On the tick
report and `scripts/limbo-census.ts` (read-only).

## L7 Owner QC never waits unseen (lib/agent/qc-overdue.ts, 2026-10-16)

Clean slating audit 2026-10-16: Ami Multani #CPS10282 and Audrea Sanchez
4196536586 sat in `awaiting_qc` 61 h and 64 h, and #CPS10292 (an AI portrait
held for the owner on /day) 62 h, with nobody told. /approve hid the first two
(placed before CPS's to-do start), so `todoOrderScope` now always carries
`awaiting_qc`: artwork handed in inside AlphaOS is this process's work.

Every tick (`runQcOverduePass`, after the per-business steps, before the L5
digest) watches each portrait waiting on an owner: `awaiting_qc`, or
`awaiting_approval` with `ai_state = owner_review`. Not archived.

- The wait starts at the latest real entry to `awaiting_qc` (a
  `from_state` other than `awaiting_qc`, so a details edit is not a new wait),
  or the latest `ai.owner_review_queued`.
- `ownerQcSlaHours` (agent_config, default 12) after that: ONE URGENT to
  `ownerUserId` (unset = every admin), on the L5 road: an `owner.question` Alpha
  event with `payload.source = "qc_overdue"`. Stamp: `qc.overdue_urgent`.
- `ownerQcBackupAfterHours` (default 2) after the URGENT, still unchecked: one
  message to the backup approver. Stamp: `qc.backup_approver`.
- Backup approver: `qcBackupApproverUserId` when it is an active admin other
  than the owner; else the other owner, worked out from the last 30 days of QC
  decisions (most on this business, then on any). Nobody with no QC history,
  unless they are the one other admin. No owner set = no backup unless named.
  Never an invented person.
- Stamps count only for the current wait, so a portrait that goes back to
  design and returns starts a new clock. An order someone has open on /approve
  (fresh `qc_claims` row) is left to them. One message per person per hour;
  each holds every due line ("*URGENT* N portraits waiting for your QC over
  12 h", one dot line per order with its /approve or /day link).
- Read only for the agent: `GET /api/agent-qc/overdue[?all=1][&businessId=]`
  (bearer AGENT_JOBS_TOKEN): `{ now, count, items: [{ orderId, orderNumber,
  shop, businessId, kind, enteredAt, hours, overdue, urgentSentAt,
  backupSentAt, next, open, owner, backup, link }] }`.

## L8 A buyer's answer is heard, and stops the reminders (2026-10-16)

Clean slating audit 2026-10-16: Emily Page 4199506964 and Megan Coakley
4197002875 approved their CPS proofs by email and AlphaOS never knew; Megan Six
4201085914's approval was classified at 97% and never applied; Shelby Leachet
4199624202 asked for changes at 20:31 and was asked to approve at 21:16. The
inbox pass only ran where `agentInboxEnabled` was on (PixArt alone).

- `lib/agent/proof-replies.ts` `runProofRepliesPass`, every tick for a business
  whose inbox switch is OFF (the inbox pass covers it when on), unless
  `agent_config.proofReplyDecisions` is false. Only orders in
  `awaiting_approval` with an undecided latest proof, only buyer words written
  after that proof. A clear change request (>= `replyConfidenceThreshold`)
  wins: back to design with her words as the revision reason. Else a clear
  approval approves. Questions, thank-yous and anything below the bar are left
  as they were (classification stored for the VA card, nothing drafted or
  escalated). Same road as a VA's tap (`applyReplyClassificationDecision`),
  stamped `agent.reply_applied`; open proof reminders on the order withdrawn.
- `lib/reminders/buyer-replied.ts`: a reply of any kind after the proof is not
  silence. The reminders sweep sends no 3-day reminder, no day-5 "customer
  silent" alert and no day-7 auto-approve; `sendMessage` withdraws a queued or
  drafted `proof_reminder` (archived draft, `email.proof_reminder_withdrawn`)
  when the buyer wrote after the proof, the proof was decided or the order
  moved on; the agent outbox withdraws such drafts instead of holding them.
