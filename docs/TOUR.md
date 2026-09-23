# The first-run tour

Owner brief (2026-09-23): "go in and do the tutorial like a real user. There
needs to be more showing than telling, and it needs to be super easy to
get... absolutely perfect."

## What it does

Every step is a demonstration on the person's real screen. A ghost pointer
(an arrow in pigment on a laptop, a tap ring on a phone) goes to the real
element and presses it, and the real page responds: a page opens, a tab
switches, a drawer slides in, a search runs. Then the page is put back and
the same element is lit with "Your turn"; the step completes the moment the
person does it themselves. No Next button. Back and Skip are small quiet
links, Esc skips.

"Watch how it works" plays every step on its own in about 34 seconds, with a
pause button, then offers "Now you try" (the interactive tour) or "Got it".
Both are on the welcome card and in the "?" menu. The Quick guide (/help) is
one screen: each step with a "Show me" that plays just that demonstration,
then hands it over.

Nothing is ever sent, assigned, passed, uploaded or deleted. The upload step
shows a sample file (drawn in the palette) landing on the drop zone; on the
person's turn their press is caught and the sample lands again, so no file
picker opens and nothing uploads.

## Steps per role

Each step has one line of copy, second person, 9 words at most.

| Role | Step | The real action | Line |
| --- | --- | --- | --- |
| VA | Today | the Today menu item | Open Today to see what needs you first. |
| VA | Find an order | types a customer's name into Orders search, Enter | Type a name, then press Enter to search. |
| VA | Needs details | the Needs Details tab | Open Needs Details for orders missing information. |
| VA | QC | Start QC (opens the review screen, read only) | Press Start QC to check the next portrait. |
| VA | Messages | opens All mail | Open All mail to see every customer email. |
| VA | Print | opens an order's Details | Open Details to see where each print is. |
| Designer | My Board | the My Board menu item / tab | Open My Board to see your orders. |
| Designer | Open a card | opens the order card | Open a card to see the order. |
| Designer | Upload | sample file onto the drop zone | Add your finished portrait here. |
| Designer | My Week | the My Week menu item / tab | Open My Week to see what is due. |
| Admin | Orders | the Overdue tab | Open Overdue to see every late order. |
| Admin | Team and sign-ins | the Designers group tab | Choose a group to see who can sign in. |
| Admin | Portrait Styles | opens a style's Designers drawer | Open Designers to choose who draws each style. |
| Admin | Settings | the Customer Email section | Open Customer Email to connect your mailbox. |
| Admin | Money | a designer's earnings | Choose a designer to see what they earned. |
| Admin | Health | the All Businesses view | Choose All Businesses to check every shop at once. |

When a page has nothing to act on (an empty QC queue, no earnings yet) the
step falls back to the page's own menu item with its own line. When the
target is already selected (the Orders view is remembered), the page is
first quietly opened at its plain view so the press visibly changes
something.

## How it is built

- `components/tour/tour.tsx`: the only part on every page. Decides whether
  the welcome card is due (`lib/tour/state.ts`, unchanged rules) and listens
  for `TOUR_START_EVENT`. The rest is `next/dynamic` with `ssr: false`, so
  an ordinary page load never fetches it. Resting on "?" (or a Show me)
  loads and mounts it idle, so a start is instant.
- `components/tour/tour-runtime.tsx`: the pointer, the lit ring, the shield,
  the sheet, watch pacing, "Your turn" detection, persistence, focus and
  aria-live. Motion is transforms and opacity only (400ms glide, 120ms press,
  400ms ripple, 220ms sheet moves); with reduced motion the pointer jumps
  and the ripple is a still ring.
- `lib/tour/player.ts`: finds real elements, travels with the real menu
  (sidebar, bottom tab, or More then the item), presses them with a real
  click, types into search the way typing does, puts the page back (back,
  close, re-click), and counts server wait apart from its own motion.
- `lib/tour/steps.ts`: the steps above, as CSS targets with fallbacks.
- Speed: on start the next two pages are fully prefetched (data included),
  and each step fetches the page after it, again after each progress save
  (a server action clears the router cache). A search submit on your turn is
  done as a client navigation to the same URL, so the tour never reloads the
  page under the person.
- Phone: the sheet floats just above the bottom tabs, which stay real
  targets; it moves to the top whenever it would cover the lit element.
  Controls are 44px. A row that scrolls sideways (the Orders tabs) is
  scrolled so the target is fully on screen.
- Persistence: as before. Finished or skipped never shows again on its own;
  Later waits for the next sign-in, up to 3 times; a run in progress resumes
  after a reload in the same sign-in.

Markers added for the tour: `data-tour="card:<status>"` on board cards,
`card:upload` and `card:drop` in the card modal, `order:customer` on the
Orders table's customer name (the search demo types it). The "?" menu gained
"Watch how it works".

## Checking it

`npm run test:tour` (local database only, see `scripts/local-db/setup-tour-db.sh`).
For each role on a laptop (1280x800) and a phone (390x844, touch, reduced
motion): watch plays end to end, interactive completes every step by
performing the real action, Done is saved and never re-shows, "?" Watch and
Show me around, Back, Esc, the Quick guide's Show me, and Later x3.
Timing gates: Start to first pointer movement under 300ms; each step's own
demonstration under 4s (server rendering time is reported beside it, not
counted); the watch's own length 30 to 45s. Screenshots per step in
`var/tour-shots/`, timings in `var/tour-shots/timings.json`.

## Judge loop (2026-09-24)

Played headless as a brand new person, from the welcome card through Watch,
Now you try and the Quick guide, reading every step's screenshot. Scored 1 to
10 on: shows more than tells (S), instantly understandable (U), fast (F),
nothing awkward or robotic in copy or motion (A), fits the calm design (D).

| Round | Role | S | U | F | A | D | What was wrong, what changed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | VA, laptop | 9 | 9 | 7 | 7 | 9 | The pointer stayed on screen during "Your turn", so it looked like the tour would press it; a leftover ripple dot sat on the page; the search demo typed "No" (it read the email column, not a name); demos on the second visit to a route waited on the network. Fixed: the pointer lifts before your turn, the ripple fades to nothing, the demo types the first customer name (`order:customer`), pages are fully prefetched one step ahead. |
| 1 | Designer, phone | 8 | 9 | 8 | 6 | 8 | My Board and My Week were shown as loading skeletons; the ring kept outlining the card behind the open card modal; the sample file rode off the right edge; the watch felt rushed (about 20s). Fixed: menu steps wait for the real page, the ring lets go of anything a dialog now covers, the sample starts inside the screen, watch pacing counts only the tour's own time (target 36s) with a short rest before each press. |
| 2 | Admin, phone | 9 | 9 | 9 | 8 | 9 | Travel through More was right; a tab row that scrolls sideways (Orders views) left the lit tab half off screen; "Overdue" was already the remembered view, so the press changed nothing. Fixed: targets are scrolled fully into view sideways too, and an already selected tab starts from the plain view first. |
| 2 | VA, phone | 9 | 10 | 10 | 8 | 10 | After a press that opens a new page, the tap ring hovered over empty space (QC); after the tab row scrolled, the ring sat on the neighbouring tab. Fixed: the finger lifts after a press that changes page, and moves back onto the element when the row scrolls under it. |
| 2 | Designer, phone | 10 | 9 | 10 | 9 | 10 | On "Your turn" the sample file was still showing, so the drop zone looked done already; "Drop" is wrong on a phone (it is a tap). Fixed: the sample shows for 0.7s then clears before your turn; the line is "Add your finished portrait here." |
| 3 | VA, laptop + phone | 10 | 10 | 10 | 10 | 10 | Clean: one line per step, every step visibly does the thing, your turn is obvious and completes on the press. |
| 3 | Designer, laptop + phone | 10 | 10 | 10 | 10 | 10 | Clean. |
| 3 | Admin, laptop + phone | 10 | 10 | 10 | 10 | 10 | Clean. Money with no earnings falls back to the Money menu item, which reads naturally. |

"Fast" judges the tour's own motion and response. Page render time on the
local dev server (reported as "server" by the check) is not counted; app
loading speed is owned elsewhere.
