# QA 2026-09-24: real-user gauntlet, admin + shared shell

Owner's words: "test everything like a real user and debug and uncamel as you
go. This needs to be absolutely perfect."

Lane: the shell (components/shell, app/(app)/layout.tsx, components/ui), login
and link pages, /help and tour copy (read only, see "Tour copy notes"), and the
admin pages (Settings, Designer Roster with Team and sign-ins, Portrait Styles,
Money, System Health, Customers). Branch `gauntlet/admin-2026-09-24`, based on
`task/alpha-program` 07467ed (what production runs). Nothing merged or deployed.

Harness: `var/gauntlet.mjs` + `var/gauntlet-flows.mjs` (gitignored, headless
Chromium via the agent repo's playwright, one context at a time). Every screen
at laptop 1280x800 and phone 390x844 (touch, 2x), Melbourne time. Per screen it
records a viewport shot and a full-length shot, layout shift (CLS), sideways
overflow, cut-off text (ellipsis / line clamp) and phone tap targets under 40px.
Screenshots: `var/e2e-shots/gauntlet-admin/roundN/` (gitignored).

Scores are 1 to 10, the lowest of (a) know what to do next, (b) copy short,
human, consistent, (c) nothing cut off, cramped or misaligned, (d) instant, no
flash or jump, (e) calm and finished. L = laptop, P = phone.

## Round 1: staging (https://alphaos-staging.vercel.app, 07467ed, mock-armed)

Signed in as staging-admin. Tour state reset so the welcome card showed, then
the whole day: login (and a wrong password), a dead sign-in link, welcome,
Watch how it works to the end, "?" menu, the first Try it step, Quick guide,
Home, Orders, Designer Roster with Team and sign-ins (added a VA, created a
sign-in link, reset the password, deactivated), Portrait Styles, Settings
(every section, the templates editor, the two email switches), Money (totals,
drilldown, Mark paid opened and cancelled, CSV), System Health, Customers and
one customer, the bell, the workspace switcher, Alpha AI (relay off), the phone
More drawer, sign out.

| Screen | L | P | Under 10 because |
| --- | --- | --- | --- |
| Login | 8 | 8 | "Internal tool. Accounts are issued by an admin." reads like a notice; placeholder `you@aystudios.io` (another business); no way out for a forgotten password; wrong-password text is 20 words |
| Dead sign-in link | 10 | 10 | |
| Welcome card | 9 | 9 | the "?" menu calls the same thing "Show me around" while the card says "Try it myself" (tour lane) |
| Watch how it works | 9 | 8 | end card "That is the whole day." (tour lane); on the phone the Orders view switch jumps rows (CLS 0.5, orders lane) |
| "?" menu / Try it | 9 | 9 | same label mismatch |
| Quick guide | 10 | 10 | |
| Home | 7 | 6 | chart day labels ran together ("Fri 11Sat 12Sun 13") and today's was cut off; Money used Today's icon; phone tiles cut off ("vs previous 7...", "Shipped by the due da..."); phone shop names cut off; "Work in flight"; floating Alpha button over the last card; phone header had no workspace name |
| Orders | 8 | 7 | orders lane: "1 email need a reply", truncated names and emails, a three-line "Assigned - Not Started" chip |
| Designer Roster + Team | 7 | 7 | menu said Designer Roster, page said Designers (and /board is also "Designers"); roster header 1rem out of line with its rows; ALL-CAPS headers unlike every other table; rank arrows at 60% opacity, 28px on a phone; your own row's buttons shifted left; long Team description; "in flight" |
| Team drawers (add, link, reset, deactivate) | 9 | 9 | fine; "Make one for me" is a quiet link-style button (kept) |
| Portrait Styles | 8 | 8 | Delete used a browser alert; every style's rule box said "e.g. Watercolor"; "Confirm once, recognised forever"; floating Alpha button over Designers |
| Settings | 7 | 6 | title sat over the right column, out of line with the section list; on the phone the section row came before the title and cut the open one ("Customer Em"); 36px section tabs; Backfill used a browser alert; "Backfill 60d", "cursor"; "The master switch. On: ... Off: ..." and ALL-CAPS ON/OFF |
| Money | 6 | 7 | titled Payouts under a menu item called Money; numbers not under their headers (each row sized its own actions column); Mark paid was a browser alert; raw "pending" chips; "1 x cartoon @ $4.00 = $4.00"; Show looked like plain text; void box and button wrapped |
| System Health | 6 | 6 | engineering words: "Mailbox poll stalls: Gmail has newer history but AlphaOS has not advanced the cursor", "AlphaOS cursor 2077; Gmail current 2096", "Stale intake >48h", "expected every 15m", "Selected" toggle, "Last run Never" |
| Customers | 9 | 9 | floating Alpha button over the last column |
| Customer page | 9 | 9 | fine, ready in 0.85 s; floating Alpha button |
| Bell | 10 | 10 | |
| Workspace switcher | 10 | 5 | on the phone the trigger showed an icon and a chevron, no name |
| Alpha AI (relay off) | 8 | 8 | answered quietly from the snapshot (good) but said 27 overdue where Home and Orders say 26; three ways in on a laptop (menu, top tab, floating button) |
| Phone More drawer | - | 7 | 240px menu inside a 320px panel: blank strip and a seam, empty footer line |
| Account menu, sign out | 10 | 10 | |

Worst: Money (L6), System Health (6/6), Workspace switcher on the phone (P5).

### Fixes (one commit each, verified on the local dev server)

| Commit | Fix |
| --- | --- |
| 73599ff | Money gets its own wallet icon |
| c71d496 | Phone menu drawer fills its panel, no empty footer |
| 5bffa26 | Alpha AI opens from the top bar tab (and the menu) only; the floating launcher that covered page content is gone; phone header shows the workspace name, 44px switcher |
| fd0ea2e | Login copy: what to use, what went wrong, forgot password |
| 1053d44, 2b4adc0 | Roster page title matches its menu item and the tour: Designer Roster (1053d44 first tried "Team"; reverted to the name the tour already uses) |
| c9c109d | Roster header lines up with its rows, sentence-case headers, rank arrows fully visible, 44px phone targets, "in progress", "0 = no limit" |
| 18fffcb | Team and sign-ins buttons line up on every row, shorter description |
| 6488d82 | Mark paid confirms in a drawer; void reason and button on one line |
| 72b42b9 | Money: title matches the menu, columns line up, "To pay / Paid / Blocked / Voided", visible Show button, plain drilldown ("2 figures, clean, $4.00 each") |
| b8b0453 | Settings: title first, section list below it on a phone with the open one scrolled into view, 44px tabs |
| df2439b, c94cdcd | System Health in plain words; the daily health email gets the same labels; "All Businesses" kept as the tour says it |
| a7cba0c | Chart day labels spaced by width, today always labelled inside the chart |
| 2d1bf2f | Home: tile hints wrap, shop names get their own line on a phone, "Work in progress against each daily limit" |
| 6155668 | Portrait Styles: Delete confirms in a drawer, rule hint uses the style's own name, plainer description |
| 21f5c9c | Settings shops: "Re-import 60 days" confirms in the app's drawer (new `ConfirmDrawer` in components/ui), "last order seen" instead of "cursor" |
| c972ba1 | Alpha AI counts overdue the same way as Home and Orders (it counted shipped orders) |
| 1dae1e2 | Customer Email switches in plain words, "On/Off", "Order updates send by themselves", Messages named as in the menu |
| b31a5ac | Tour copy left to the tutorial lane (restored lib/tour/steps.ts and guide.ts) |

Also fixed while the Mac was paused for load (06:40 to 07:03; dev server,
proxy and browsers stopped, code reading and edits only):

| Commit | Fix |
| --- | --- |
| 5678295 | Roster description: "New orders go to the first designer on this list who draws the style and is under their daily limit." |
| 7d84798 | Customer page: "Customer since" instead of a warning tile "Spend: Not tracked"; Files, QC, Messages, From customer / From us |
| 76bce29 | Settings: "Saved. Leave blank to keep it" instead of "Set - leave blank to keep"; "All set."; reminder test says Checked / Would send / Already sent / "Nobody would be notified." |
| 1947b19 | Products to confirm: checkbox beside its product on a phone, long titles wrap; "went to cartoon by default" |

## Round 2: local dev server (all round 1 fixes, `npm run db:local-tour` + `npm run seed:history`)

Same walk, as tour-admin on the local copy (Lumina + PixArt, 8 weeks of
history), plus the Re-import confirm, the Portrait Styles designers and delete
drawers, a real Mark paid, and a template Save.

| Screen | L | P | Under 10 because |
| --- | --- | --- | --- |
| Login | 9 | 9 | a wrong password cleared the email field; the forgot-password line left "one." alone on a phone |
| Dead sign-in link | 10 | 10 | |
| Welcome, Watch, "?" menu, Try it | 9 | 9 | tour lane notes below |
| Quick guide | 10 | 10 | |
| Home | 10 | 9 | "Full queue" link a 20px target on a phone |
| Orders | 8 | 8 | orders lane (below) |
| Designer Roster + Team | 9 | 9 | rank arrows 13px and faint; phone style picker and daily limit 36px |
| Team drawers | 10 | 9 | drawer close 32px on a phone |
| Portrait Styles + drawers | 9 | 8 | rule chip remove button 13px; 32px buttons; (Products checkbox fixed in 1947b19) |
| Settings | 8 | 8 | import-rule and non-portrait inputs squashed to 19px high; saving a template unchanged marked it Customized; the mailbox card started closed, hiding the two switches; Re-import looked like plain text; 28px setup links, 32px buttons |
| Money (mark paid, CSV) | 10 | 9 | 32px View orders / Mark paid; the phone CSV tap did not start a download in headless Chromium |
| System Health | 10 | 8 | on a phone the status chips stretched the full row |
| Customers / customer page | 10 | 8 | four full-width tiles pushed the orders below the fold on a phone; 32px paging |
| Bell, workspace, Alpha, More, account | 10 | 9 | 32px menu items and chat controls; "WORKSPACE" in capitals |

Worst: Settings (8/8), then Portrait Styles, System Health and the customer
page on a phone (8).

### Fixes

| Commit | Fix |
| --- | --- |
| 56fe742 | Small buttons, workspace/account menu items and Alpha chat controls are 44px on a phone (components/ui Button `sm`, top bar, chat) |
| 5e7b0b7 | 44px setup links, page-size and paging links, View orders; Export CSV has `download` |
| a1b9d8e | Drawer close and toast dismiss 44px on a phone |
| 6a8bb8e | Home card links, roster style picker and daily limit, rule chip remove: 44px on a phone |
| 754ef8c | Saving a template unchanged keeps it on Default |
| 4d8ef56 | Customer Email mailbox card opens by default, switches in sight |
| 5f81d28 | Import rules: inputs full size again (flex-1 on the input collapsed it), "A number / Words to numbers", "Apply to existing orders", short summary of what changed |
| 13aabbc | Re-import 60 days is a proper button |
| b47fd03 | System Health chips hug their text on a phone |
| a3b4eb7 | Customer page tiles two by two on a phone, "Customer since Sept 2026" |
| 5b8a6fc | Rank arrows 16px |
| d536589 | Wrong password keeps the email and focuses Password; "Forgot your password? Ask your admin." |
| 363821d | No ALL-CAPS labels left in the shell or admin Settings |

## Round 3: local dev server (all round 2 fixes)

The Mac's load average was 150 to 190 during this round (five agents), so the
dev server answered some laptop page loads after the harness's 30 s limit:
login, the dead link, the welcome card, Settings and Money page loads, and the
customer click timed out on the laptop pass. Those were re-run once the load
dropped (`round3b`: login, link, welcome, Watch to the end, all passed) and the
Settings and Money screens are covered by the section and flow shots of the
same pass. One "tree hydrated but some attributes didn't match" console error
was logged per size; loading each of the 17 admin pages fresh afterwards
(`var/hydration.mjs`) logged none, and rounds 2, 3b and 4 logged none, so it
was a hot reload landing mid-run, not a page defect.

| Screen | L | P | Under 10 because |
| --- | --- | --- | --- |
| Login (email kept, cursor in Password) | 10 | 10 | |
| Dead sign-in link, Quick guide, Home, Money, Customers list | 10 | 10 | |
| Welcome, Watch, "?" menu, Try it | 9 | 9 | tour lane notes below |
| Orders | 8 | 8 | orders lane (below) |
| Designer Roster + Team + drawers | 10 | 10 | |
| Portrait Styles | 10 | 9 | products panel arrow not at the edge on a phone; "SKU SKU-1018-1"; the row checkbox a 16px target |
| Settings | 10 | 9 | on a phone the figure rule's option name was squeezed to "Num"; Connect/Reconnect links 32px; info bubble 20px; shop style box 36px; saving an unchanged template said "now uses your text" |
| System Health | 10 | 9 | business toggle 32px on a phone |
| Customer page | 9 | 9 | long product titles cut off; a second "1 figure" chip from the variation; 31 s to load on the phone pass (dev server at load 160; staging served it in 0.85 s) |
| Bell, workspace, Alpha, More, account | 10 | 9 | the menu's home link 36px |

Worst: the customer page (9/9).

### Fixes

| Commit | Fix |
| --- | --- |
| d26fc58 | Info bubbles and the menu home link 44px on a phone |
| eaac2e5 | Connect/Reconnect, shop style box and Add, Health toggle 44px on a phone |
| adf4c26 | Products checkbox 44px tap area |
| 59b5c67 | Figure rule option name on its own line on a phone; honest template-saved toast |
| e7fcdda | Customer page: product titles wrap, no repeated "1 figure" |
| 2159cee | Products panel arrow at the edge on a phone; no doubled "SKU" |

## Round 4: local dev server (all round 3 fixes), the last round

Load average 180 to 450 for most of the round. The harness waited up to 120 s
per page, so every screen was reached except the end of Watch how it works
(the Money step's page load outlasted the 90 s watch limit; the welcome card,
the first four steps and round 3b's full watch passed) and the Export CSV
download (20 s harness limit; `var/csv.mjs` then downloaded
`alphaos-payouts-2026-09.csv` on both sizes). Mark paid had nothing left to
pay after rounds 2 and 3 paid every designer; the drawer and toast were
checked in rounds 2 and 3.

| Screen | L | P | Under 10 because |
| --- | --- | --- | --- |
| Login, dead link, Quick guide | 10 | 10 | |
| Welcome, Watch, "?" menu, Try it | 9 | 9 | tour lane: "Show me around" in the "?" menu vs "Try it myself" on the card; "That is the whole day." |
| Home | 10 | 10 | |
| Orders | 8 | 8 | orders lane (below) |
| Designer Roster, Team and sign-ins, add / link / reset / deactivate | 10 | 10 | |
| Portrait Styles and its drawers | 10 | 10 | the designers drawer had Save/Cancel on the left, unlike every other drawer: fixed in c51db05 |
| Settings (every section, templates, the two switches, Re-import) | 10 | 10 | |
| Money (totals, drilldown, CSV) | 10 | 10 | |
| System Health | 10 | 10 | |
| Customers, customer page | 10 | 10 | page loads were 14 to 29 s on the dev server at load 150+; the production build on staging served it in 0.85 s |
| Bell, workspace switcher, Alpha AI (relay off), More, account, sign out | 10 | 10 | |

Remaining tap targets under 44px on a phone are inline text links inside
sentences (the Customers breadcrumb, an order number, "Portrait Styles" in a
sentence), which WCAG 2.5.8 exempts, and the product checkbox, whose label
now gives it a 44px tap area around the 16px box.

Seen and not fixed: in two long phone runs under load, one dev-only React
warning "a tree hydrated but some attributes ... didn't match" on /login (a
`style` attribute on the email input). It did not reproduce on a fresh
/login, after a wrong password, after sign-out, with typing before hydration
at 20x CPU throttling, or on any of 17 admin pages at either size
(`var/hydrate-login.mjs`, `var/hydration.mjs`). Production does not log it.

## Final verification (after merging task/alpha-program 3366c16, merge f756214)

Merge conflicts: the customer page (kept "Customer since" over the VA lane's
"Spend: Not recorded"; took their wrapping QC and Files rows) and alpha-chat
(kept the floating launcher removed; the VA lane had hidden it on /qc/ for the
same overlap). The "?" menu keeps the VA lane's "Try it myself".

All under `nice -n 15`, one dev server, one browser context at a time:

- `npm run lint`: clean.
- `npm run build`: green.
- `bash scripts/ci-local.sh` (CI_DB=alphaos_ci_gauntlet_admin, proxy port
  4471 so it could not collide with the other lanes): `test:all OK: 22/22`.
- `npm run test:tour` (fresh `npm run db:local-tour`): 812 passed, 0 failed.
  Two earlier full runs at load 60 to 190 each failed the admin "Now you
  try" start (the check polls the sheet right after the press and stops if it
  still reads the watch-end card or a page in flight); admin alone passed
  300/0 and 160/0 in between, and the third full run at load 20 passed
  812/0.

## Tour copy notes (for the tutorial lane; not edited here)

- (Done by the VA lane, merged) The "?" menu said "Show me around" for what the welcome card calls "Try it
  myself". One name for one thing; "Try it myself" is the clearer of the two.
- Watch end card "That is the whole day." and done card "You are ready." read
  stiff; "That's the day." / "You're ready." would be warmer.
- The Designer Roster page title is now "Designer Roster" (was "Designers"),
  matching the menu and the tour's "Open Designer Roster ..." line, so no tour
  change is needed for it.
- System Health toggle is "PixArt | All Businesses" (was "Selected | All
  Businesses"); the tour's "Choose All Businesses" still matches.

## Other lanes (seen, not touched)

- Orders (components/orders): "1 email need a reply" (should be "needs");
  customer names, emails and "Next action" hints cut off at 1280px; the
  "Assigned - Not Started" status chip wraps to three lines.
- Watch on a phone: switching Orders views shifts the rows (CLS about 0.5 per
  switch).
- components/orders/new-order-form.tsx passes `className="flex-1"` to an
  `Input`; that is the same bug that squashed the Settings import-rule boxes
  to 19px (flex-1 lands on the input inside the field's column wrapper). Wrap
  the Input in a `min-w-0 flex-1` div instead.
- components/designers/week-view.tsx (shared with the designer's My Week) still
  has ALL-CAPS labels (Phone, Channel, Timezone, Quiet hours); left to the
  designer lane.

## Shared files touched outside the listed pages (heads-up for the other lanes)

- components/ui/button.tsx: `size="sm"` buttons are at least 44px tall on a
  phone (`min-h-11 sm:min-h-0`); laptop unchanged. Affects every screen.
- components/ui/drawer.tsx, toast.tsx, info-bubble.tsx: 44px close / dismiss /
  info targets on a phone. New components/ui/confirm-drawer.tsx.
- components/alpha/alpha-chat.tsx: the floating launcher is gone (top bar tab
  and menu item open the chat); chat controls 44px on a phone.
- lib/alpha/snapshot.ts: overdue uses the same status list as Home.
- lib/health/daily-report.ts: plain signal labels (also in the daily email).
- components/home (primitives, staff-home) and components/charts/bars.tsx:
  VA Home shares these (hint wrap, label spacing, shop rows, 44px card links).
- app/(app)/layout.tsx is unchanged; the shell's main padding changed in
  components/shell/app-shell.tsx (pb-24 on a phone, lg:pb-10) since nothing
  floats over the page any more.
