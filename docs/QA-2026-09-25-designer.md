# QA 2026-09-25: designer lane, full test + debug + uncamel

Owner order: "test every function of alphaOs. go in like every user level and
test everything. do not stop until you have tested and then debugged and
uncamelled every section and that you are 1000% happy with it and that this
work is the best work youve ever created."

Lane: the designer, phone first (390x844, touch, iPhone UA), then laptop
(1440x900). Branch `lane/2026-09-25-designer`, worktree
`~/Documents/projects/alphaos-wt-designer`. Every screen is judged 1 to 10 on:
(a) I know what to do next, (b) short human copy that names things the way
the app does, (c) nothing cut off, cramped or under 44px on a phone, (d)
instant, nothing flashes, (e) calm and finished. A screen's score is its
lowest criterion. Mechanical audit on every screen: sideways scroll, clipped
or ellipsised text, tap targets under 44px (phone), text under 11px, em
dashes, and every email address in the DOM and in every response body
(the designer's own address on their account menu is the only one allowed).

## Carried over from the cut-off run (committed first, one concern each)

| Commit | What the designer sees |
|---|---|
| adc0f30 | "Earned today" on My Week and My Board counts the designer's own day, not the server's (UTC) |
| 1936c0a | Card photos never name an uploader by email to a designer (the uploader's name, or nothing) |
| 30cf351 | Chart labels at 11px (Home had 14 labels under 11px on a laptop, 5 on a phone) |
| 34afce1 | Countdown: no hydration warning when the minute ticks between server and browser |
| 5dd9b14 | My Week contact labels in sentence case (were ALL CAPS) |
| 6dc6f21 | Upload progress rows keyed by position, so two files with one name keep their place |
| 329baca | Card detail labels in sentence case (Status, Your deadline, Labels, ...) |
| 721f524 | Quick guide in the designer's More sheet (it was only in the "?" menu) |
| 8d5b8d1 | Phone nav rows, the More sheet close button and the account button are 44px |

## Round 1: staging (https://alphaos-staging.vercel.app, 9e7ec97, mocks armed)

Signed in as staging-designer. Orders: PC32148 (phone) and PC32151 (laptop),
both assigned and in My Queue at the start. VA side as staging-va for the QC
fail. Tour screens (welcome, Watch how it works, Try it myself, ending cards)
were walked on both sizes by the cut-off run on this same deploy; this run
re-read those shots.

Walked, phone then laptop:
- Tour: welcome card, Watch how it works (every step), Now you try (all four
  steps, each done on the lit element), "You are ready", Quick guide, "?" menu.
- Home: sentence, four tiles, Due first rows (open the card), My Board split,
  figures chart.
- My Board: open by ?open= (phone), Enter on a focused card (laptop), Start in
  the card (phone), drag My Queue to In Design (laptop), upload a .txt, an .svg
  and a 27 MB PNG (each refused), a PNG then a JPG (phone, "Portrait versions
  (2)"), a PNG dropped on the drop zone (laptop), version and customer photo
  open full size (200, image), a comment (Send on the phone, Ctrl+Enter on
  the laptop), Submit for QC (toast "PC32148 sent for QC", the card moves at
  once).
- QC fail by staging-va with a note; back as the designer: the card shows
  "QC failed", the VA's words first, the failed checks, "Add a new version
  with the changes, then submit it for QC", and the board card offers
  "Add a new version", not Submit.
- Alpha AI (relay off): opens, answers "What is due first?" from the
  designer's own board in 1.6 s; an order that is not theirs (PC32170) is
  never named back.
- Notifications ("You're all caught up."), sign out (to /login, and /board
  then asks to sign in: the session is revoked).
- Access (cut-off run's matrix on this deploy, re-read): every staff page
  sends a designer to My Board (307); /api/alpha/* and /api/cron/* answer
  401/403/405; every board server action replayed with an order that is not
  theirs answers "Order not found" (loadCard returns nothing, postComment,
  moveOrder, presign and save uploads all refuse); a designer can never move
  their own order to awaiting approval or complete ("Illegal transition").
- No email address other than the designer's own anywhere in any DOM or
  response body, on any screen, either size.

### Scores (phone / laptop)

| # | Screen | Phone | Laptop | What was wrong |
|---|---|---|---|---|
| 1 | Welcome card | 10 | 10 | |
| 2 | Watch how it works | 10 | 10 | |
| 3 | Try it myself + ending cards | 9 | 9 | (d) "You are ready" lands over My Week's loading skeleton for a moment |
| 4 | Home | 8 | 8 | (b) "Figures this week" over "Last 7 days" and a "vs last week" delta: a rolling 7 days named like the calendar week the earnings tile beside it counts; (a) chart days and "Assigned today" in Melbourne's calendar, not the designer's; a voided earning counted as delivered figures |
| 5 | My Board | 9 | 8 | (e) laptop: after a drag, screen readers hear "Draggable item 81002665-9902-... was dropped over droppable area inDesign" (raw id, column key) and dnd-kit's default "press space or enter to pick up" (Enter opens the card here, there is no keyboard drag); laptop: the name in the top bar is cut ("Staging Desig...") |
| 6 | Card, queued + Start | 10 | 10 | |
| 7 | Upload | 6 | 6 | (b) a .txt gives "No images selected"; an .svg passes the browser check then fails on the server as "Upload failed / drawing.svg: not an image" (an SVG is an image) and leaves a red "Failed" row; a 27 MB file: "Upload too large", no way forward |
| 8 | Comments | 8 | 8 | (b) every time is relative ("8m ago", "3d ago"), no exact time in the designer's own zone, even on hover |
| 9 | Submit for QC | 10 | 10 | toast "PC32148 sent for QC", card moves at once |
| 10 | Failed QC card | 10 | 10 | note first, then the checks, then what to do |
| 11 | My Week | 9 | 9 | (b) "On-time this week" reads a lone "-"; month total by the server's month, not the Money page's period (same today, can drift) |
| 12 | Order link as a designer | 3 | 3 | (a) a notification or pasted link to /orders/<own id> opens the STAFF order page: "Customer" with no name, the order's due date (14 Sept, long past) instead of their own deadline (25 Sept), "Waiting for the designer to finish", Melbourne times; a link to an order that is not theirs shows Next's bare "404 This page could not be found." |
| 13 | Alpha AI | 7 | 8 | (c) phone: message box 40px, Send 40x40; (b) quick answer "You have 0 orders in your queue ... Next deadline: PC32148, PC32151." |
| 14 | Notifications, account, sign out | 10 | 10 | |
| 15 | Quick guide + "?" menu | 10 | 10 | every designer answer checked against the code: true |
| 16 | Every text field on a phone | 7 | n/a | (c) the comment box, Alpha AI and sign-in fields are 14px: iOS Safari zooms the page into any field under 16px on tap and stays zoomed |

### Fixes after round 1

| Commit | Fix |
|---|---|
| bed399c | Upload: only PNG, JPG, WebP, GIF, HEIC files are offered and accepted; any other file: "That file can't be added. notes.txt is not a PNG, JPG, WebP or HEIC image. Save it as a PNG or JPG and try again." Too big: "That file is too big. huge.png is over 25 MB. Save a smaller copy ...". Nothing half-uploads |
| ae98905 | Board drag announcements: "Picked up PC32151.", "PC32151 moved to In Design."; instructions say Enter opens the card |
| 61fd0f8 | Card activity: older than a day shows "Tue 22 Sept 3:10 pm GMT+7" in the designer's zone; every time has the exact moment on hover |
| 12b2ea1 | A designer's /orders/<id> (notifications, pasted links) opens the card on My Board |
| b732bc5 | ?open= for an order not on the board: "That order is not on this board. It may be finished, or with another designer now." |
| 21e5650 | Home: chart days and Assigned today in the designer's zone; voided earnings are not delivered figures |
| f7d0e71 | Home: tile reads "Figures, last 7 days", delta "vs the 7 days before" |
| 32e3921 | My Week and My Board month = the Money page's period (earnings.period); a voided earning is not an order done |
| bc516a4 | My Week: On-time "None yet" |
| bac6c23 | Top bar name shows in full on a laptop (shell, minimal) |
| 142bb29 | Text fields are 16px on a touch screen (globals.css, unlayered, laptops keep 14px) |
| 9b97afc | Alpha AI message box and Send 44px |
| 77fa5ce | Alpha AI quick answer: "Nothing new in your queue, 1 in design and 1 waiting for QC. Due first: PC32148, then PC32151." |
| 3a8b3ae | Board (found reading the drop code against the transition table): a Failed QC or Revisions card dropped on In Design was sent to the server as in_design to in_design ("Illegal transition"); an Awaiting QC card dropped on In Design is a QC fail, which needs QC's signed reason, so the designer got a sign-off error. Both now leave the card where it was; Awaiting QC back to My Queue still works, as the Quick guide says |
