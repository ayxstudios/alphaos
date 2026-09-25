# QA 2026-09-25: simplicity lane

Owner order: walk AlphaOS as a new person who knows nothing, find where it overwhelms, then make it plain,
short and friendly. Above all QC, "because that's where most of the work will be done".

Walked on staging (https://alphaos-staging.vercel.app), mocks armed, phone 390x844 and laptop 1440x900.
Orders changed: PC32162 (assigned to Staging Designer, portrait added, submitted, PASSED with the proof email)
and PC32156 (assigned, portrait added, submitted, FAILED on Likeness). Nothing else was changed.

## What a new person felt

I am a new hire. I was sent a login and told "just use it". I have never seen AlphaOS.

### First impression, in one line

The login, Today, the order page's "Next step" box and the designer's board are easy: one big button tells me
what to do. Everything around those buttons is too much: Home is a wall of numbers and manager words, every
order card says "overdue" three times, and the QC screen, the one I will live in, has three controls on every
checklist line, long sentences full of words like "artefacts" and "house look", three helper lines before the
buttons, and nothing that tells me what Pass or Fail will actually do.

### Ratings (before)

"Knew" = I knew what to do. "Calm" = not too much stuff. 1 to 10.

| Screen | Who | Knew | Calm | What stopped me |
|---|---|---|---|---|
| Login | all | 10 | 10 | nothing |
| Home | VA phone | 6 | 4 | wall of tiles and charts; "Nothing for later", "15 to link to an order", "Triage", "Designer load" |
| Home | VA laptop | 6 | 5 | same words |
| Home | admin phone | 6 | 4 | "On time: No data", "3 / 104 new today" |
| Home | designer phone | 8 | 7 | "In my queue 2 / 1 in design" but the bar says In design 0; "Figures" |
| Tour (watch) | VA phone | 8 | 8 | it leaves "Shane" in the search box so a step shows an empty list; QC step never shows QC |
| Tour (try) | VA phone | 7 | 8 | "Open it" while I am already on Today |
| Today | VA phone | 8 | 6 | chip "Triage"; "Soon nothing here Done" |
| More menu | VA phone | 10 | 9 | fine |
| QC list | VA phone | 7 | 8 | "QC" never explained; "Late" and "58 min" overlap; minutes of what? |
| QC list | VA laptop | 8 | 9 | "1 hour" of what? |
| QC review | VA phone | 5 | 4 | 3 controls per line, long jargon lines, 3 helper lines, no "what happens next" |
| QC review | VA laptop | 6 | 5 | 4 things per line (box, tick, cross, key number) |
| QC email preview | VA phone | 7 | 4 | "Template: Proof ready . physical . single", "image/png . 0.0 MB raw", checklist repeated |
| QC fail box | VA phone | 7 | 7 | ALL five items came pre-marked as failed when I had crossed only one |
| After Pass / Fail | VA phone | 6 | 10 | dropped back on the list with no "done" message I could see |
| Orders list | VA phone | 7 | 4 | Overdue pill + date + "5d 0h overdue" on every card; "No designer is free. Assign one." |
| Order page | VA phone | 8 | 3 | a dozen sections; second designer picker; 13 templates; long revision sentence; CAPITAL labels |
| Messages | VA phone | 7 | 5 | spam in "Needs you"; "Waiting to send 131 drafts" |
| Board | designer phone | 8 | 6 | raw shop text on every card; failed card shows a bare list of item names |
| Card: add + submit | designer phone | 9 | 7 | CAPITAL labels in the sheet; "Figures ?" |
| Settings (first) | admin phone | 8 | 8 | "Live-order cutoff set / All shops protected" |
| Money | admin phone | 9 | 9 | empty state repeats the header |

### The QC walk, step by step (the part that matters most)

1. **QC list.** Title "QC". I guessed it means checking the portrait. "1 portrait waiting, soonest due first." One big
   "Start QC" button: good. Each row: "PC32151 Sh PixArt Shopify Late 58 min Staging Designer . 3 figure..."
   The "Late" pill and "58 min" sit on top of each other on the phone. I could not tell if 58 min is how late it is
   or how long it has waited. No picture of the portrait, just an eye icon.
2. **Review header.** "Awaiting QC" and "in QC 48m" say the same thing twice. "Figures 3" (people? pets?).
   "1 of 1 in queue <- Prev Next ->".
3. **Zoom bar** ("100% - + Reset", on laptop "scroll to zoom, drag to pan, both sides move together") comes before the
   pictures. I do not need it first.
4. **Pictures.** "Reference" and "Delivered (latest)". I had to guess that Delivered is the designer's work and
   Reference is the customer's photo. Nothing told me "compare these two".
5. **Checklist.** "Checklist 0/5 Tick all". Each line has a checkbox, a tick and a cross (and a key number on the laptop).
   Which one do I press? The tick and cross are small (about 28px on the phone). The lines are long:
   "Anatomy and finish: hands, fingers and ears are correct, no artefacts, edges clean at print size".
6. **Helper lines.** "Tick every item to unlock Pass. 0/5 done" / "Sign off type your name to unlock Pass and Fail" /
   "Typed by hand, matching Staging VA." I stopped reading at the second one.
7. **Buttons.** Fail (pink) and Pass (purple), same size. When everything is ticked, Fail is still just as loud.
   Nothing says Pass emails the customer, or that Fail sends it back to the designer.
8. **Pass.** A big box "Preview customer email" opens. "Template: Proof ready . physical . single . Physical order with
   one figure." / "Portrait attached to this email" / "PixArt-PC32162.png . image/png . 0.0 MB raw" / "QC checklist
   completed" and the five long lines again / then the email / "Body edits for this send only" / "Send email and pass QC".
   The last button is clear. The rest is machine talk. I only understood this goes to the customer by reading the email.
9. **Fail.** I crossed only "Likeness". The fail box opened with all five items marked as failed. I had to untick four.
   In a hurry I would have told the designer that everything was wrong. The reason box and "Fail & return to
   designer" were clear.
10. **After.** Both times I landed back on the QC list with no "Sent" or "Sent back" that I noticed.

### Every wordy or jargon phrase, word for word

- Home: "Nothing for later", "15 to link to an order", "1 waiting for QC" (under Overdue orders), "By kind, everything
  in the queue", "Unassigned", "Triage", "Details", "QC checks", "The bigger picture", "Where every open order is",
  "Designer load", "Work in progress against each daily limit", "On time / No data", "3 / 104 new today".
- Today: "Across 2 shops: 20 need you now, 22 for today.", chip "Triage", "Soon nothing here Done",
  "Open Messages to link them to the right order."
- Tour: "Some orders arrive missing information. Open Needs Details to see which ones need you.",
  "Finished portraits wait here for your check. Press Start QC to review the next one." (shown on the wrong page),
  "Today lists what needs you first. Open it and work from the top down." (while on Today).
- QC list: "soonest due first", "Late" + "58 min", "0 figures".
- QC review: "Awaiting QC", "in QC 48m", "Figures", "1 of 1 in queue", "scroll to zoom, drag to pan, both sides move
  together", "Delivered (latest)", "3 reference photos:", "Tick all",
  "Likeness: faces, eye colour, hair colour and hairstyle match the reference photos",
  "Count: number of people, pets and hands matches the order, nothing added, removed or duplicated",
  "Style: matches the ordered style and the house look, not too realistic or cartoonish",
  "Details: jewellery, tattoos, pet markings and any visible text are correct and legible",
  "Anatomy and finish: hands, fingers and ears are correct, no artefacts, edges clean at print size",
  "Tick every item to unlock Pass. 0/5 done", "1 marked X", "Sign off type your name to unlock Pass and Fail",
  "Your name, typed by hand", "Typed by hand, matching Staging VA.", "Versions".
- Email preview: "Template: Proof ready . physical . single . Physical order with one figure.",
  "PixArt-PC32162.png . image/png . 0.0 MB raw", "QC checklist completed", "Body edits for this send only".
- Fail box: "Select what's wrong and tell the designer how to fix it.", "Failed items", "Reason for the designer (required)".
- Orders: "No designer is free. Assign one.", "Figure count unknown. Set it.", "This step", "5d 0h overdue".
- Order page: CUSTOMER / EMAIL / DESIGNER / DUE in capitals, "Copy this, paste it into your email to the customer,
  then tap Mark as sent.", "Proof ready . digital . single" (and 12 more), "Edit freely before copying. This never sends
  anything by itself.", "Sent" + "draft" on one message, "Reassign or request a revision",
  "Revisions can start once an order is awaiting customer, approved, printing, shipped, delivered or complete.",
  "Created -> Ready to assign", "Add a VA note, customer update, designer context, or follow-up result...".
- Messages: "Waiting to send 131 drafts".
- Board: "Need Your Order Within 72 Hours? (For Digital Portraits or Approvals *NOT SHIPPING TIME*): No Thanks"
  (raw shop text, repeated on every card), "Figures ?", STATUS / YOUR DEADLINE / LABELS / ORDER NUMBER in capitals,
  "Ready for QC. To change it first, add a new version.", failed card list "Count, Style, Details, Anatomy and finish".
- Settings: "Live-order cutoff set / All shops protected".
- Money: "An order counts once it is complete." said twice.

### Buttons I did not dare press

- "Tick all" on QC: feels like cheating the check.
- The tick next to a checkbox: is it different from the checkbox?
- "Mark as sent" on the order page: sent what, by whom?
- "Request revision" (grey, with a sentence I could not parse).

### Bugs seen on the way (not wording)

- Fail box pre-marks every unticked item as failed, not only the ones crossed.
- Watch tour leaves "Shane" in the Orders search, so the Needs details step shows an empty list.
- Designer phone: "Submit for QC" could not be tapped by Playwright right after an upload (the tap point hit the
  customer photo); a script click worked. Board lane should check the sheet's stacking on a real phone.
- QC list row on the phone: the "Late" pill and the time overlap.

## Round 1: what changed

Rule followed: fewer words, one clear next step, nothing removed. Every action still exists (tick, untick, mark
wrong, undo wrong, Tick all, keys 1-5 / A / F / Enter / J / K, zoom, versions, email edit, Cancel).

### QC review (components/qc, lib/qc/checklist.ts)

- Checklist line: the checkbox, the separate tick button and the cross were three controls. Now the whole line is
  the tick (tap it, 44px tall) and there is one cross button (44px) for "wrong"; tapping the cross again undoes it.
  The duplicate tick button is gone because tapping the line does exactly the same thing.
- Each line shows the name in bold and what to look for underneath.
- Checklist heading "Checklist 0/5" -> "Does it match? 0 of 5".
- Checks (lib/qc/checklist.ts DEFAULT_CHECKLIST, same keys, same "Name: detail" shape the board relies on):
  - "Likeness: faces, eye colour, hair colour and hairstyle match the reference photos" -> "Likeness: faces, eyes and hair match the photos"
  - "Count: number of people, pets and hands matches the order, nothing added, removed or duplicated" -> "Count: right number of people and pets, nothing extra or missing"
  - "Style: matches the ordered style and the house look, not too realistic or cartoonish" -> "Style: the style they ordered, not too real, not too cartoon"
  - "Details: jewellery, tattoos, pet markings and any visible text are correct and legible" -> "Details: jewellery, tattoos, markings and any words are right"
  - "Anatomy and finish: hands, fingers and ears are correct, no artefacts, edges clean at print size" -> "Finish: hands, fingers and ears look right, edges are clean"
- Three helper lines ("Tick every item to unlock Pass. 0/5 done", "1 marked X", the sign-off hint) -> ONE line that
  always says the next step:
  - nothing wrong yet: "Tap each line that looks right. Tap the cross if something is wrong."
  - all ticked: "All good. Sign your name, then press Pass." then "Press Pass. You will see the customer email before it sends."
  - something marked wrong: "1 marked wrong. Sign your name, then press Fail." then "Press Fail and tell the designer what to fix."
- Sign-off field untouched: "Sign your name:" with placeholder "Your name" (owner order).
- Pass vs Fail: Fail is a quiet outline button until a line is marked wrong, then it turns solid red. Pass stays purple.
- Header: "in QC 48m" -> "waiting 48m"; "1 of 3 in queue" -> "1 of 3".
- Pictures: "Reference" -> "Customer photo"; "Delivered (latest)" -> "Designer's portrait"; "Delivered (v1)" ->
  "Designer's portrait (version 1)"; "3 reference photos:" -> "3 customer photos:";
  "scroll to zoom, drag to pan, both sides move together" -> "scroll to zoom, drag to move, both pictures move together".
- "This order is no longer awaiting QC (now in design). Nothing to review." -> "Already checked. This order is now in design."
- Versions hint "Showing latest, tap another to compare" -> "Showing the newest. Tap another to compare."
- Email preview:
  - "Preview customer email" -> "Check the email, then send" + "The customer gets this email with the portrait attached."
  - "Template: Proof ready . physical . single . Physical order with one figure." -> small line "All 5 checks ticked. Email: Proof ready . physical . single."
  - "Portrait attached to this email" -> "Attached portrait"; "PixArt-PC32162.png . image/png . 0.0 MB raw" -> "PixArt-PC32162.png".
  - The five checks repeated in full -> gone (the one line above says all 5 were ticked).
  - The email body was shown twice (a preview box and an edit box). Now once, as the edit box "Message" with the hint
    "You can change it. Changes are for this email only." (was "Body edits for this send only").
  - "Cancel" -> "Back". "Send email and pass QC" kept.
- Fail box:
  - BUG FIX: it pre-marked every unticked line as wrong, so crossing one told the designer all five were wrong. Now it
    starts with the lines you marked wrong; if none, the unticked ones only when you had ticked some; else nothing.
  - "Fail this portrait / Select what's wrong and tell the designer how to fix it." -> "Send it back to the designer / Pick what is wrong and say how to fix it."
  - "Failed items" -> "What is wrong?"; "Select at least one failed item." -> "Pick at least one thing that is wrong."
  - "Reason for the designer (required)" -> "Note for the designer"; placeholder "Be specific: e.g. left eye should be green, ring on wrong hand..." -> "For example: the left eye should be green."
  - "A reason is required." -> "Write a short note so the designer knows what to fix."
  - "Fail & return to designer" -> "Fail and send back". Close button 32px -> 44px, lines 44px tall.
- Keyboard list: "Toggle checklist item" -> "Tick or untick a line", "Tick all items" -> "Tick all", "Toggle this legend" -> "Show or hide this list".

### QC list (app/(app)/qc/page.tsx)

- "3 portraits waiting, soonest due first." -> "Check each portrait before the customer sees it. 3 waiting, most urgent first."
- Row: the bare time on the right ("58 min", which sat on top of the Late pill on a phone) -> "Waiting 58 min . Staging Designer . 3 figures . Cartoon".
- Empty: "Nothing waiting for QC / When a designer submits a portrait it lands here." -> "Nothing to check / When a designer finishes a portrait, it shows up here."

### QC messages (app/(app)/qc/actions.ts, lib/orders/transitions.ts)

- "Not signed in" -> "Please sign in again."; "QC is VA/admin only" -> "Only VAs and admins can do QC."
- "Pass QC from the email preview so the attachment is verified before sending." -> "Press Pass, then send it from the email screen."
- "This order is no longer awaiting QC." -> "Someone already checked this one."
- "The portrait asset could not be read." -> "The portrait file could not be opened. Ask the designer to add it again."
- "A newer portrait was uploaded after the preview opened. Refresh QC and review the latest file." -> "The designer added a newer portrait. Refresh and check that one."
- "The portrait file changed after the preview opened. Refresh QC and review the current file." -> "The portrait changed while you were looking. Refresh and check it again."
- "This proof email was just sent. Refresh QC to see where the order is now." -> "This email was just sent. Refresh to see where the order is now."
- "Email sent, but order transition failed: X" -> "The email went out, but the order did not move on. Tell an admin. (X)"
- "Select at least one failed item" -> "Pick at least one thing that is wrong."; "A reason is required to fail QC" -> "Write a note for the designer first."
- "All checklist items must be ticked to pass" / "Cannot pass QC: every checklist item must be ticked." -> "Tick every line before you pass."
- "Cannot fail QC: mark at least one checklist item as failed." -> "Mark at least one line as wrong before you fail."
- "Cannot fail QC: a reason for the designer is required." -> "Write a note for the designer before you fail."
- "The sign-off must match the name on your account (X)." -> "Sign with the name on your account: X."
- "Resolve figure count before sending a proof email." -> "Set how many people and pets are in this order first."

### Tour and Quick guide (lib/tour, components/tour, docs/TOUR.md)

- Today: "Open it and work from the top down." -> "Tap Today and work from the top down."
- Needs details: "Some orders arrive missing information. Open Needs Details to see which ones need you." -> "Some orders arrive with details missing. Open Needs details to fill them in."
- QC: "Finished portraits wait here for your check. Press Start QC to review the next one." -> "QC is where you check each finished portrait. Press Start QC to check the next one." (and the menu version).
- BUG FIX: the watch tour now clears its demo search before the next step (the Needs details step showed an empty list).
- Quick guide answers shortened, all still true. "How do I pass or fail QC?" now: "Open QC and press Start QC. Look at
  the customer photo and the portrait side by side. Tap each line that looks right, or the cross if something is wrong.
  Sign your name. Pass shows you the customer email before it sends. Fail asks what is wrong, then sends it back to the designer."
  Other answers: dropped repeated clauses ("nothing moves until a person confirms", "the customer's due date stays the same",
  "in the card or under it", "until QC checks it") and split long sentences.

### Home and Today (components/home, lib/home/staff.ts, components/today)

- "For today ... / Nothing for later" -> "... / Nothing else coming" ("N for later" -> "N more coming soon").
- "Replies to send ... / 15 to link to an order" -> "15 with no order yet" ("All linked to orders" -> "All on their orders").
- "Overdue orders ... / 1 waiting for QC" -> "N more due today" / "Nothing else due today".
- "What is waiting / By kind, everything in the queue" -> "Everything on Today, by kind".
- "Where every open order is / 39 open orders by stage" -> "Open orders by stage / 39 open".
- "Designer load / Work in progress against each daily limit" -> "How busy designers are / Orders each one has, out of their daily limit".
- Queue kind "Triage" -> "Order type" (Home, Do first chip, Today chip); "Quiet proofs" -> "Unanswered proofs" (short chip "No answer").
- Do first line "N for later" -> "N soon". Today empty band "nothing here  Done" -> "all clear" + a green tick.

### Orders and order page

- Card hints: "No designer is free. Assign one." -> "Needs a designer. Assign one."; "Figure count unknown. Set it." -> "How many people or pets? Set it."
- Phone card Due: an "Overdue" pill above the date -> one red line "Late, 25 Sept 2026". "This step" -> "Time on this step".
- Order page: capital labels CUSTOMER / EMAIL / DESIGNER / DUE -> normal case.
- Draft reply: "Copy this, paste it into your email to the customer, then tap Mark as sent." -> "Copy it, send it from your email, then tap Mark as sent." (Etsy: "Copy it, send it in the Etsy conversation, then tap Mark as sent.")
  "Edit freely before copying. This never sends anything by itself." -> "Change it as you like. Nothing sends from here."
- Messages on the order: "Sent" + "draft" (two chips that contradict) -> one chip: "Sent", "Not sent yet" or "Not sent".
- "Reassign or request a revision" -> "Change designer or ask for a revision".
- "Revisions can start once an order is awaiting customer, approved, printing, shipped, delivered or complete." -> "You can ask for a revision once the customer has seen the portrait."
- Note placeholder "Add a VA note, customer update, designer context, or follow-up result..." -> "Write a note for your team".

### Messages, board, Settings, Money

- Messages: "Waiting to send / 131 drafts" -> "Not sent yet / 131 emails"; "Nothing waiting to send." -> "Every email has gone out."
- Board card: failed checks "Count, Style, Details, Anatomy and finish" -> "To fix: Count, Style, ..."; "Figures ?" -> "Figures not set";
  sheet "Ready for QC. To change it first, add a new version." -> "Ready. Press Submit for QC, or add a new version first."; capital labels in the sheet -> normal case.
- Settings: "Live-order cutoff set / All shops protected" -> "Start date for live orders set / Older orders come in archived".
- Money empty state: "Designers earn when their orders are complete. Pick another month to look back." -> "Pick another month to look back." (the header already says it).
