# The first-run tour

Owner order (2026-09-25): "The tutorial is too fast and camel, it should be
normal paced and you should have them click it, you only point to what they
should click. like circle it on there, and point with arrows and stuff."

## What it does

The tour points, the person clicks. For each thing to press:

- the page dims softly (ink at 34%) around a rounded cut-out of the real
  element, with a 2px pigment ring around it: one gentle pulse when it
  arrives, then still;
- a thin curved pigment arrow with a small open arrowhead runs from the step
  card to the ring (no shadows, no glow). Under the 2px line sits a thin 5px
  surface-coloured underlay at 85%, so the line stays crisp where it crosses
  text; it is a flat backing, not a glow;
- the card says what the thing is (a short title) and what to press (one
  line under it), with "2 of 6", and quiet Back and Skip links. Esc skips.

Focus: the ring never steals focus from a mouse or touch user (a browser
focus ring inside the pigment ring reads as two rings). Focus moves onto the
ringed element only for a keyboard user (last input was Tab, or Enter or
Space on a control; Enter typed in a text box, such as a phone keyboard's Go
after a search, does not count), and always for a text box (the search), so
typing just works.

There is no Next button: the person's own click is the next. Nothing is
pressed, typed, sent, assigned, passed, uploaded or deleted for them. A
shield blocks presses anywhere but the ringed element; a press elsewhere
gives the ring one soft pulse and nothing else.

To reach a step's page the tour first rings the page's menu item (the
sidebar on a laptop, the bottom tab on a phone, or More then the item), with
the step's own line for that page. On the page it rings the thing to press.
The only things the tour ever does itself are quiet housekeeping: closing a
drawer the person opened in an earlier step when the next step lies
elsewhere, and opening a list at its plain view when the thing to press is
already the selected one.

Pace: every motion is 220 to 400ms (ring glide 320, card move 320, arrow
draw 360, pulse 400, a 420ms sage "Done" before the next step). Nothing
moves on its own once it has arrived, and there are no countdowns. With
reduced motion there is no glide, pulse or draw: things simply appear.

The welcome card offers "Show me around" and "Skip" (and "Later" in its
corner). "Watch how it works" (the old auto-play) is gone everywhere. The
"?" menu has "Show me around" and "Quick guide". The Quick guide lists the
steps; each has "Point me to it", which opens that step's page with that one
thing lit and closes once the person has done it.

The upload step rings the drop zone. The person's press on it is caught, a
sample file (drawn in the palette) lands there, and no file picker opens.

## Layout

- Phone (390x844): the card is a sheet just above the bottom tabs, 8px from
  each side. A target below it is scrolled up to sit just above it, so the
  arrow stays short. A tab in the bottom bar gets the ring around the tab
  and the sheet lifts to leave room for the arrow. The arrow never runs over
  half the page: a target high on the screen that cannot come down to the
  sheet (the top of a page) gets the sheet just under it (56px away), and a
  target the bottom sheet would cover (an item low in the More drawer) gets
  the sheet just above it, else just under it, else at the top. A row that
  scrolls sideways (the Orders tabs, the Settings sections) is centred first
  when its item is cut off or within 8px of the edge. Controls are 44px.
- Laptop (1440x900): a 360px card beside the target, 64px away, never on
  it: to the right of a sidebar item, else below, above or to the side,
  whichever fits; the arrow runs between them. A card below or above a
  target in the page stays over the page, never over the sidebar.
- Both: 12px card radius, the largest shadow token, calm type (16px
  semibold title, 14px slate line).

## Steps per role

Each step has two short plain sentences, 12 to 22 words: what the thing is,
then what to press. The card shows the first as its title.

| Role | Step | What is ringed | Line |
| --- | --- | --- | --- |
| VA | Today | the Today menu item | Today lists what needs you first. Tap Today and work from the top down. |
| VA | Find an order | Orders menu item, then the search box (type, Enter) | Search finds any order fast. Type a customer's name, then press Enter. |
| VA | Needs details | the Needs details tab | Some orders arrive with details missing. Open Needs details to fill them in. |
| VA | QC | QC menu item, then Start QC | QC is where you check each finished portrait. Press Start QC to check the next one. |
| VA | Messages | Messages menu item, then All mail | Messages holds every customer email. Open All mail to read or search them. |
| VA | Print | Print menu item, then an order's Details | Print lists approved orders ready to print. Open Details to see where each one is. |
| Designer | My Board | the My Board menu item / tab | My Board holds every order given to you. Open it to see what is due first. |
| Designer | Open a card | an order card | Each card is one order with the customer's photos. Open a card to see the details. |
| Designer | Upload | the drop zone in the open card | Your finished portrait goes on the order card. Add it here when the design is done. |
| Designer | My Week | the My Week menu item / tab | My Week shows your deadlines and what you earned. Check it at the start of each day. |
| Admin | Orders | Orders menu item, then the Overdue tab | Orders holds every order from every shop. Open Overdue to see the late ones first. |
| Admin | Team and sign-ins | Designers menu item, then the second group tab | Team and sign-ins lists everyone who can sign in. Choose a group to see who is in it. |
| Admin | Portrait Styles | Portrait Styles menu item, then a style's Designers button | Each style goes to the designers who draw it. Open Designers to choose who they are. |
| Admin | Settings | Settings menu item, then Customer Email | Settings connects your shops, email and printers. Open Customer Email to connect your mailbox. |
| Admin | Money | Money menu item, then a designer | Money shows what each designer has earned. Choose a designer to see their orders. |
| Admin | Health | System Health menu item, then All Businesses | Health flags problems behind the scenes. Choose All Businesses to check every shop at once. |

While the menu item is ringed the card shows the step's page line (for
example "Orders holds every order from every shop. Open it to find the one
you need."). On a phone, when the page is under More, More is ringed first:
"Messages is in the More menu at the bottom. Tap More, then tap Messages."

When a page has nothing to act on (an empty QC queue, no earnings yet), the
menu item that brought the person there was the step. When the target is
already selected (the Orders view is remembered), the page is first quietly
opened at its plain view so the press visibly changes something. If the
designer's card is not open for the upload step, the card is ringed first.

## How it is built

- `components/tour/tour.tsx`: the only part on every page. Decides whether
  the welcome card is due (`lib/tour/state.ts`, unchanged rules) and listens
  for `TOUR_START_EVENT`. The runtime is loaded on demand; resting on "?"
  (or a Quick guide button) loads and mounts it idle, so a start is instant.
- `components/tour/tour-runtime.tsx`: the spotlight (one element: a rounded
  box whose 2px pigment shadow is the ring and whose 200vmax shadow is the
  dim), the pulse, the arrow (one SVG, drawn from where the card and the ring
  really are each frame), card placement, the shield, completion on the
  person's own click / Enter / press, persistence, focus and aria-live.
- `lib/tour/player.ts`: finds real elements and walks a step as a chain of
  links (menu item, then the thing on the page); never presses anything.
- `lib/tour/steps.ts`: the steps above, as CSS targets with fallbacks.
- Speed: on start the first two pages are prefetched with their data, and
  each step prefetches the page after it. A search submit is done as a
  client navigation to the same URL, so the page never reloads under the
  tour.
- Persistence: as before. Finished or skipped never shows again on its own;
  Later waits for the next sign-in, up to 3 times; a run in progress resumes
  after a reload in the same sign-in.

Markers used by the tour: `data-tour="nav:<path>"`, `tab:<path>`,
`tab:more`, `card:<status>` on board cards, `card:upload` and `card:drop` in
the card modal, `page:orders` on the Needs details tab, `team` on the Team
panel, `order:customer` on the Orders table.

## Checking it

`npm run test:tour` (local database only, see
`scripts/local-db/setup-tour-db.sh`). For each role on a laptop (1440x900)
and a phone (390x844, touch): the welcome offers Show me around and Skip and
no Watch; for every ringed thing the ring surrounds the real element, the
page is dimmed around a cut-out, an arrow runs from the card to the ring,
the card is on screen, never on the element, says "N of M", has no Next
button and 44px controls on a phone, the copy is two sentences of 12 to 22
words, motion is 220 to 400ms; nothing moves or changes for 1.2s after
arrival and no click reaches the page that a person did not make; the check
then does the real thing and the step must move on by itself. Then Done is
saved and never re-shows, "?" has no Watch item and Show me around rings
within 300ms, Back, Esc, the Quick guide's Point me to it, and Later x3.
Screenshots per ringed thing in `var/tour-shots/`.
