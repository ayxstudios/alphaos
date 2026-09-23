# QA 2026-09-23: designer journey, round 2 (staging, mock-armed)

Walked on https://alphaos-staging.vercel.app as staging-designer, with
staging-va (QC, print, ship, complete, reassign), staging-admin (styles,
team) and an anonymous customer on /proof. Headless Chromium, phone 390x844
first, then laptop 1280x800. Screenshots: `var/e2e-shots/designer-r2/`
(gitignored).

## Walked

1. Re-verify round 1 fixes: board, Home and My Week show the assignment
   deadline (PC32148: customer SLA 10 days past, board shows "21h left";
   with the assignment pushed 3h past it turns rose "overdue 3h" on all
   three surfaces, others stay slate). Search filters own cards (phone
   `/board?q=`, laptop top bar, no-match state with Clear search).
   Unstarted card says "Start this card first". "Add new version" wording.
   Card payloads (POST /board), Home, board and /me carry no customer email
   before and after an email.sent activity row exists. Reference photos
   open full size (HEAD 200 image/jpeg). No sideways scroll.
2. PC32169 (4 figures, cartoon at 4.00): QC pass with mock proof email,
   customer revision, resubmit, QC pass, customer approve, tracking +
   Shopify fulfil (mock), delivered, complete. One earning: 16.00, pending,
   breakdown 4 x 4.00 cartoon. Shows on board (Today/This month, Earnings
   history row with figures, rate, amount, status), Home and /me. Blocked
   case: PC32151 set to style `r2-norate` (rate nulled in the staging DB,
   the UI refuses a style without a rate), walked to complete: earning
   `blocked` "Style r2-norate needs a per-figure rate", designer sees
   "blocked / Needs rate" with no error, admin sees it under "Needs a rate
   before it can be paid" on /payouts with Resolve and Void.
3. Admin added "R2D Designer B" from Designers. VA reassigned PC32165:
   old assignment inactive, new one due +24h, `orders.due_at` unchanged;
   old designer lost it on board/Home/My Week and gets a 404 on its order
   page; new designer sees "23h 59m left".
4. Customer revision on the proof (chip + note + 1 pin): designer's card
   shows "Revision requested", the note, "1 pin on the image" and the pin
   over the latest version; v4 uploaded, resubmitted, QC passed again;
   earnings did not double (unique per order).
5. Admin deactivated Designer B: open session sent to /login on the next
   request, sign-in refused with the deactivated hint, gone from the order
   picker, bulk picker, board rail and roster. Reactivated: signs in, card
   back, back in pickers and roster.
6. As designer: /orders, /orders/new, /orders/[id]/complete, /settings,
   /customers, /qc(/id), /today, /emails, /designers(/id), /styles,
   /queue/print, /health, /payouts, /payouts/export redirect to /board;
   another designer's /orders/[id] shows 404; `/board?designer=<other>`
   shows only their own board. API: /api/alpha/{rundown,events,order/[id]}
   401, /api/cron/* 401, /api/{assets/sweep,etsy/sync,gmail/poll,
   shopify/sync} 403, /api/{etsy,gmail}/connect 307 to /login,
   /api/alpha/chat answers from the designer's own snapshot only. No stack
   traces.
7. Laptop: board drag from My Queue to In Design works; Home, board, My Week
   fit 1280 wide.

## Defects

### P2 (fixed on this branch)

- Earnings history said "N paid orders" while listing pending and blocked
  earnings (a designer is told they were paid). 4db8a65.
- A completed card kept a live deadline countdown in the Complete column and
  card modal; after the deadline it turns rose "overdue". Now "Done". 280a4d1.
- My Week "On-time" compared completion time (after customer approval,
  print and shipping) with the customer SLA, so a designer handed an already
  late order, or any physical order, reads late. Now: first hand-off to QC
  vs the designer's own assignment deadline. PC32151 read 50%, now 100%.
  e4a4934.
- Deactivating a designer counted only in-design and awaiting-QC orders as
  still with them, so a queued (assigned, not started) order was left with
  an inactive designer while the panel said nothing. 0b300ab.

### P3 (log)

- After QC pass the order vanishes from the designer's board, Home and My
  Week until it completes (days later for print); no signal the pass
  happened. The Complete column only lists `complete`.
- The card modal has no Submit for QC; the designer closes it and taps the
  card button. After the first upload the modal still says "Add a new
  version before submitting to QC".
- Resubmitting after a revision is not gated on a new version (the check is
  "at least one submission ever"); QC is the only gate.
- A customer revision keeps the original assignment deadline; the revision
  round gets no deadline of its own.
- Same deadline, two clocks: card modal uses the browser zone (5:39 pm AEST),
  Home and My Week use Asia/Jakarta (2:39 pm), Home without a zone label.
- Designer /orders/[id]: "DUE" is the customer SLA next to "Designer
  deadline", and CUSTOMER reads "Customer" instead of the first name.
- My Week lists queued cards as "Ready to assign" (staff wording); Home
  says "1 live orders".
- The denied /orders/[id] page is a 404 body with HTTP 200.
- A browser chunk (`/_next/static/chunks/2611-*.js`) contains the
  node-postgres package.json (author email, connection-string doc text):
  server DB driver code reaches a client bundle. No secrets.
- /api/alpha/chat forwards any `orderId` a designer sends to the Alpha relay
  without checking the assignment. Relay is off on staging, so not
  verifiable; if the relay loads /api/alpha/order it would see another
  designer's order (first name, items, activity). For the security lane.
- /styles cannot clear a rate or add a style without one; a null rate only
  comes from legacy data (this walk nulled it in the staging DB).

### Out of lane

- VA /orders search stays inside the current view (default Overdue): a
  search for a shipped order says "Nothing in overdue".
- /qc/[id] still throws React hydration error #418.

## Staging state left

PC32169 and PC32151 complete (earnings 16.00 pending, one blocked); style
`r2-norate` (rate null) exists for the blocked case; PC32165 assigned to
R2D Designer B (active); PC32148 in design for staging-designer.
