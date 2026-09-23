# QA 2026-09-24: VA gauntlet (first real morning)

Owner brief: "test everything like a real user and debug and uncamel as you
go. This needs to be absolutely perfect." Played as a new VA on their first
morning, laptop 1280x800 and phone 390x844, headless. Every screen scored 1 to
10 on: (a) next step obvious without reading much, (b) copy short, human,
consistent, (c) nothing cut off, cramped, overlapping or misaligned, (d)
instant, nothing flashes or jumps, (e) calm and finished. Screenshots:
`var/e2e-shots/gauntlet-va/roundN/` (gitignored), `<screen>-laptop.png` and
`<screen>-phone.png`.

Branch: `gauntlet/va-2026-09-24`, based on `task/alpha-program` 07467ed (what
production and staging run).

## Where each round ran

- Round 1: staging (https://alphaos-staging.vercel.app, mock-armed) as
  staging-va@alphaos.test for the welcome, Watch how it works, Try it myself,
  and every read-only screen at both sizes. Staging had nothing in QC or Print,
  so the actions (complete details, assign, QC fail and pass with the proof
  email, Messages, Print send and tracking) ran on a LOCAL copy of the same
  commit: `npm run db:local-tour` into `alphaos_tour_va`, then
  `npm run mock:pipeline` for realistic Etsy and Shopify orders and mail, two
  QC orders given reference and portrait images, and one physical order made
  print-ready. That database is snapshotted and restored before every round.
- Rounds 2 onward: the local server on the fixed branch (staging does not have
  the fixes). The machine was under heavy load from parallel lanes, so rounds
  ran one dev server and one browser at a time under `nice`.

## Round 1 (staging + local, unfixed 07467ed)

Worst screens: Orders (5), QC review (6), Complete details (6), Print (6).

| Screen | Laptop | Phone | Under 10 because |
| --- | --- | --- | --- |
| Welcome card | 9 | 9 | Fine; card sits over the Do first list (acceptable for a first-run card). |
| Watch how it works | 8 | 8 | With an empty QC or Print page the line flips mid-step ("Press Start QC..." becomes "Open QC..." after the pointer lands). |
| Try it myself | 9 | 9 | Same flip on QC and Print. |
| Home | 9 | 7 | Phone: "0 not matched to an or..." cut off; "0 not matched to an order" reads oddly. |
| Today | 7 | 6 | "12 someone is waiting on you"; task text starts at a different x on every row (varying shop and order widths); phone cuts every task off ("Enter the details fro..."); "Reply to X, waiting 3 min" repeats the age shown beside it; "... 2 soon across 2 shops". |
| Orders (all views) | 5 | 7 | Status chips are jargon and wrap to 3 lines ("Assigned - Not Started", "Awaiting VA Details", "Needs VA Review"); names, emails, designers, due lines and review reasons end in "..."; due line repeats the status ("16h overdue · Awaiting details"), which even contradicts it ("Not started" vs "Ready to assign"); "1 email need a reply"; tabs in Title Case unlike every other label; empty view says "Nothing in awaiting qc"; phone cards say "Stage time". |
| Order page | 8 | 7 | Phone: the Next step card squeezes "Complete the order details" into 3 lines beside the button; "Defaulted to classic, not matched, please confirm"; activity reads "Awaiting Details → Ready To Assign"; an approved print says "start the print & ship job" with no way to get there. |
| Complete details | 6 | 6 | Style choices are raw keys ("line-art"); save button "Save details → Awaiting photos" and hint "No photos → lands in awaiting-photos · never emails the customer"; the photo link box is 20px tall and half width; after saving, a badge "Completed X → ready to assign ✓" and a bare "Back to orders →"; listing title cut off; header "PixArt · PixArt Etsy · Etsy order ..." then the same shop again in a badge; "Developer data"; the page loads behind the Orders table skeleton, then jumps. |
| Assign | 8 | 8 | Toast "Order assigned" arrives while the page still says Unassigned and the button spins for about 2 s more. |
| QC queue | 9 | 9 | Fine. After the last portrait the VA lands on an empty Orders view ("Nothing in awaiting qc"). |
| QC review | 6 | 7 | The floating Alpha AI button covers the sign-off field and Pass; a stray "-" after the status chip; version card date cut off; after Fail, the Pass button spins. |
| QC fail dialog | 9 | 9 | Fine (every unticked item pre-selected by design). |
| QC pass + email preview | 8 | 8 | Toast "Email sent, sent to approval"; a failed send shows the raw Gmail JSON error. |
| Messages | 8 | 7 | "Customer mail, newest need first."; the link-to-order box has no label ("Search order number" only); phone draft rows right-align a wrapping meta line. |
| Print | 6 | 6 | Action button reads "Sent to print" (past tense); a printing order shows "Sent, waiting" and "Not sent yet" together; unlabeled "20d 20h"; tracking form opens with a stray rule, no Cancel, "fulfillment" spelling and "Add tracking & fulfill in Shopify"; toast "Sent-to-print signal recorded."; empty state "needs a VA to trigger printing". |
| Customers | 9 | 9 | "one record per email" is system talk. |
| Customer page | 8 | 8 | "QC / VA", "Assets", "Latest work: ... · Re-resolved", a warning-toned "Spend: Not tracked" card. |
| Quick guide | 10 | 10 | Clean. |

## Fixes (branch commits)

- `f91e155` Today: aligned rows, no cut-off tasks on phone, plain section counts, no repeated ages.
- `153a4e9` Orders: one short status vocabulary, nothing cut off, plain reasons, "needs", sentence-case tabs, empty view copy, "This step" on phone.
- `8e01c18` QC: spinner on the pressed button only, back to the QC queue when done, human email error, plain toasts, no stray "-", whole date on version cards.
- `9763c06` Alpha AI: no floating button on the QC review screen (shared shell component, minimal).
- `3eb6beb` Assign: the page shows the designer in the same response as the toast.
- `40a5f4d` Complete details: plain button and hint, readable style names, a clear finish with "Back to Needs details", full-size photo link box, one-line header, form-shaped skeleton.
- `64847f0` Order page: Next step fits a phone, "Guessed classic. Please check it.", sentence-case activity, an approved print links to Print, Orders eyebrow.
- `8870091` Print: "Mark as sent", one consistent status line, "sent 2d ago", tracking form with Cancel and plain wording, plain empty state and toasts.
- `ba91405` Messages: "Which order is this about?", phone draft rows, header copy; compose is a real dialog with Escape.
- `c505b70` Customers and Home: plain customer facts, VA Home tile "12 to link to an order".
- `361b419` Tour: an empty page's line changes as the pointer turns (shared tour runtime, one optional hook).

## Round 2 (local dev server, fixed branch)

Full walk at both sizes (the phone Complete details step was retried after a
script fix). Worst: Orders laptop 7.

| Screen | Laptop | Phone | Under 10 because |
| --- | --- | --- | --- |
| Welcome, Watch, Try | 10 | 10 | Clean; QC step no longer flips (the local queue has work). |
| Home | 10 | 10 | |
| Today | 10 | 10 | |
| Orders | 7 | 8 | Laptop: the one-line status chip plus help icon spilled into the Designer column; "Review QC" cut to "Review...". Phone: the open view pill sat half off the right edge. |
| Order page | 10 | 8 | Phone: Edit ran 8px past the right gutter (header actions could not wrap); eyebrow "PixArt Etsy · Etsy". |
| Complete details | 10 | 10 | |
| Assign | 10 | 10 | Page and toast now land together (0.8 s). |
| QC review | 9 | 9 | React hydration mismatch on every QC page (the sign-off field's random name). |
| QC email preview | 8 | 8 | "Send email & pass QC" below the fold under a 12-row box. |
| Messages | 9 | 10 | Laptop: Needs you rows indented 20px past their header (an invisible dot slot). |
| Print + tracking | 9 | 10 | "Add tracking URL" ghost button indented off the field edge. |
| Customers / customer page | 10 / 9 | 10 / 10 | "Last change" value cut off. |
| Quick guide / "?" menu | 9 | 9 | Menu said "Show me around", the welcome card says "Try it myself". |

Fixes: `d790dad` (hydration), `8da1f99` (send in view), `b26c49b` (status
column, phone open tab), `0804787` (header actions wrap, shared PageHeader one
class; eyebrow), `07b7bf6` (message rows, tracking link, customer facts, "?"
menu label in the shared top bar, tour check updated).

## Round 3 (local dev server, machine load 100 to 250)

Laptop walked end to end. Phone: the dev server hung serving Print during
Watch how it works and the rest of that walk was blocked by the still-running
tour; the phone screens reached (Home, Today, all Orders views, Customers,
Help) were checked. Worst: Orders laptop 8.

| Screen | Laptop | Phone | Under 10 because |
| --- | --- | --- | --- |
| Orders | 8 | 9 | Laptop: the widened status column tipped the table into sideways scroll, pinning Next action; Source and Designer were added by JavaScript after hydration, so on a slow load they popped in; a long email wrapped mid-word. Phone: open tab not verified (tour overlay). |
| QC email preview | 9 | n/a | The proof link ran past the pane edge. |
| Home | 10 | 9 | "0 coming up soon", "16 need you now, 30 today, 0 soon". |
| Everything else walked | 10 | 10 | |

Fixes: `e1b6368` (columns decided in CSS on first paint, action column sized
to its button, email wraps at @), `2948228` (fits 1280 again), `6901136`
(long links wrap in previews and bodies), `630f0ea` (Home zero counts, shared
Home component, copy only).

## Round 4 (production build `npm run build` + `next start`, local)

Full walk at both sizes on the built app, including the proof email send
(mock Gmail) and tracking writeback, all steps passing. Page loads 0.9 to
1.2 s, save/assign/fail/mark sent 0.3 to 0.9 s at moderate load; the machine
was at load 70 to 270 from parallel lanes, which stretched a few steps.

| Screen | Laptop | Phone | Notes |
| --- | --- | --- | --- |
| Welcome, Watch, Try | 10 | 10 | Watch 44 to 48 s under load. Twice the search demo fell back to "Open Orders to see every order." after results took over 10 s at load 170+; clean on staging and in round 2 (environment, not code). |
| Home | 9 | 9 | Do first rows say Reply three times (kind chip, task, button). Shared Home component, left for the admin lane (below). |
| Today, Orders (all views), Order page, Complete details, Assign, QC queue, QC review, QC fail, Messages (open, link, reply compose), Print, tracking, Customers, customer page, Quick guide | 10 | 10 | No cut-off text, no sideways scroll, no hydration errors on any VA page. |
| QC email preview | 10 | 9 → 10 | Phone: the Send bar only appeared after scrolling into the reply pane. Fixed with a dialog footer (`cf4bd46`, `e6e8965`), rebuilt and re-verified: Send in view at the top and after scrolling at 390x844 and 1280x800, send lands on QC. |

## Still under 10, and why

- Home "Do first": each row reads Reply / Reply to the customer / Reply. The
  list is the shared attention list also used by admins; changing its row
  design is the admin/shell lane's call.
- Shell (not changed, shared): the sidebar has "Designers" (boards) next to
  "Designer Roster"; Alpha AI appears three times (sidebar, top bar, floating
  button); the business switcher says "Workspace" while pages say the
  business name.
- Style names show as stored keys in chips on the order, QC and customer
  pages ("classic", "cartoon"); fixed in the Complete details form only,
  since the chips are shared display code.
- Local dev only: `next dev` does not route integration calls through the
  mock transport (proof send and the sync cron fail there, raw 401 before the
  fix); the production build does. The QC error message is now human either
  way.
- Data, not code: mock-imported orders have no customer name ("Unknown
  customer") and no due date; staging has a test style "r2-norate".

## Verification

`npm run lint` clean, `npm run build` green (twice, the last on the final
code), `bash scripts/ci-local.sh` (as `CI_DB=alphaos_ci_va`) `test:all OK:
22/22 passed`. Tour check not run: it resets the shared `alphaos_tour_test`
database other lanes were using; its "?" menu label was updated.
