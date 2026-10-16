# AlphaOS 2.0 agent-first build (approved by Yousif 2026-09-29 14:15)

Spec: docs/AGENT_FIRST.md (commit f38d00d). Branch task/agent-first, worktree alphaos-wt-agentfirst.
Safety gates: demo env first, drafts + one-tap approve for email, sandbox print, no prod credential changes.
Yousif will provide Etsy access via AnyDesk for messages (not yet arrived; not a Phase 1 blocker, buyer messages arrive as Etsy notification emails).

## Build order
- Ph1 intake + assignment autopilot  <- IN PROGRESS
- Ph2 agent runs the inbox
- Ph3 print submission + print QC
- Ph4 Day screen + overview + exception inbox
- Ph5 capacity model + per-business rollout

## Ph1 plan (decided 2026-09-29)
- lib/agent/: autopilot tick (intake completeness check -> exception or drafted email; assignment via existing assign.ts), agent_actions log, exceptions table, per-business agent config flags (default OFF, demo ON)
- API tick route following the existing cron pattern
- Minimal exceptions list page (full inbox is Ph4)
- Prove on demo env (own Neon db, mock orders), then commit

## Log
- 2026-09-29 14:20 worktree created off origin/main c084d99, spec cherry-picked
- 2026-09-29 14:20 recon worker dispatched
- 2026-09-29 14:24 commit c6c2d33: exceptions table + agent flags + completeness (unit test OK)
- 2026-09-29 14:40 RESTART recovered. Decisions: agent log = activity_log actor null with agent.* actions (no new table); new template key photo_shortfall (mig 0042); Ph1 proof = preview deploy of this branch on demo env vars (alphaos-demo alias untouched, its tooling lives on unlanded task/alphaos-reqc8bcc)
- 2026-09-29 14:40 workers dispatched: A = autopilot core + cron route + mig 0042 + db test; B = exceptions page + settings toggles + labels
2026-09-29: Agent Ph1 UI: /exceptions page (staff, resolve + 7-day resolved), agent intake/assign switches in Settings > Customer Email, sidebar Exceptions item, agent.* activity labels.
2026-09-29: Agent Ph1 autopilot (dcdef48): lib/agent/autopilot.ts runAgentTick (Etsy intake, photo completeness + photo_shortfall draft, auto-assign, exceptions), /api/cron/agent every 15 min (?dryRun=1), migration 0042 photo_shortfall enum applied to demo, npm run test:agent-autopilot passes on demo (flags reset off).
2026-09-29: Agent Ph2 inbox: lib/agent/inbox.ts runInboxPass (apply clear approvals/revisions as system actor, draft answers to questions via draftFreeformReply, reply_unclear/buyer_question/unmatched_reply exceptions, proof_reminder drafts), migration 0043 agent_inbox_enabled + agent_config (applied to demo), settings toggle, npm run test:agent-inbox passes on demo (flag reset off). Not pushed.
2026-09-29: Agent Ph3 print (f278b32): lib/print/prepare.ts preparePrintOrder (final file, mapping, cost, address, blockers), routing.ts chooseProvider (businesses.print_routing, migration 0044 applied to demo; Lumaprints default, Gelato override), submit.ts one-tap submit (api print job, approved->printing, print.submitted activity, printing email), Print and ship card on /orders/[id], npx tsx scripts/test-print-submit.ts ALL PASS on demo (mock providers). Not pushed.
2026-09-29 15:25: Agent Ph2 inbox committed as 352bc34 (runInboxPass: apply clear approvals/revisions, draft answers, escalate unclear/unmatched, proof reminders; mig 0043). Re-verified: tsc ok, lint ok, npm run test:agent-inbox all pass on demo db, agent_inbox flag reset off after.
2026-09-29 15:25: Agent Ph3 print committed as f278b32 (preparePrintOrder, chooseProvider with businesses.print_routing, one-tap submit, reconcile to shipped; mig 0044). Re-verified: npx tsx scripts/test-print-submit.ts 18 PASS incl. print_routing override picks Gelato, mock providers only, print_routing restored after. Not pushed, not deployed.
2026-09-29 16:15 RESTART recovered again. Ph2 352bc34 + Ph3 f278b32 + 8dc53bc verified (tsc, lint, inbox test, print test all green). Ph4 workers running: c5affa0be082 = /day screen (lib/agent/day.ts, app/(app)/day), 0c008af9ea07 = /overview + exceptions polish (lib/agent/overview.ts, app/(app)/overview). On resume: delegate({resume}) both, review, commit Ph4 with explicit paths, then Ph5 (capacity model + per-business config), preview deploy on demo env (alias alphaos-agent.vercel.app), full gauntlet, then ask Yousif for the production go.
2026-09-29 16:40 Moved to worktree .claude/worktrees/alphaos-wt-agentfirst-req91c88 (branch task/alphaos-wt-agentfirst-req91c88 = task/agent-first + Ph4/Ph5). Ph4 afaebc7 (/day, /overview, exceptions). Ph5 committed: capacity (lib/agent/capacity.ts, rebalance.ts, /designers/capacity), config (lib/agent/config.ts, nav.ts, Settings > Agent). tsc + lint clean; tests capacity/config/autopilot/inbox/completeness ALL PASS on demo; print test needs a fresh approved physical demo order (data consumed, not a regression). NEXT: preview deploy on demo env (alphaos-agent.vercel.app), gauntlet, reply to Yousif.
2026-09-29 17:30 Preview deployed alphaos-agent.vercel.app (dpl alphaos-jckj2ygo4), demo flags ON, gauntlet PASS, fix d8a02e2. Sent Yousif the link, waiting on his production go (then LANDING steps).
2026-09-29 18:05 NEW TASK (Yousif additions, msg 18:02): 1 auto-send agent emails (no drafts) + fix Failed send; 2 Trello legacy-order strategy; 3 unindexed new products -> pick-designer action; 4 per-product AI designer opt-in (agent fulfills, VA QC, owner approves each at first; PixArt Disney pet = CSS storybook flow); 5 easy reassignment; 6 AI revisions by AI + self-check before VA QC; 7 friendlier VA QC compare UI; 8 simpler tour (non-English VAs); 9 record-as-you-go stage lookup (revision visible); 10 glance-clear needs-you cards. Plan: wave1 W1 inbox auto-send (no settings/config edits), W3 backend AI designer (schema mig 0045, API, hard), W4 independent UI; wave2 W5 unmatched intake+Trello (mig 0046), W6 agent-side runner (ai-employee-agent repo), W7 UI wire-up; then gauntlet + redeploy alphaos-agent.vercel.app preview. Touchups recorded tac244dc4, t3bf78efe.
2026-09-29 18:55 Waves done. W1 72d8b76 auto-send inbox (outbox pass, retry 3x then email_send_failed exception, mock-gmail transport fix, glance-clear Messages cards). W3 AI designer backend (mig 0045: styles.ai_designer_enabled/ai_framework, designer_profiles.is_agent, orders.ai_state; jobs API /api/agent-designer/* bearer AGENT_JOBS_TOKEN; owner_review hold; reassignOrder; 52/52 test). W4 8d4effb VA UI (QC compare, pointing tours, quick reassign, /orders/find lookup, stage timeline w/ revision rounds, Day card one-liners). W5 a3cd6c9 legacy/Trello intake (mig 0046: order source legacy/trello, trello_card_id, styles.auto_created; stub orders + confirm card; new-product pick-designer card; scripts/import-trello.ts; docs/trello-transition.md). W7 d8658ad UI wire-up (styles AI toggle+framework, owner-review Day card, AI badges, reassign via reassignOrder). W8 44d6908 fixes (job re-list after fail/reassign, dev photo GET w/ bearer, autopilot test for auto-send, demo exceptions tidy). Agent repo: pipelines/alphaos-ai-designer (run.mjs list/fulfil/sweep + pixart-disney-pet framework, commit 4291a88); demo order AIDEMO-1790672346606 delivered into awaiting_qc via stub; REAL generation pending image-lane reset ~22:35 UTC, resume registered. Next: deploy preview + alias alphaos-agent.vercel.app, gauntlet, reply.
2026-09-29 20:40 AEST: Gauntlet c6fe9ee5a3d6 items 1-10 PASS, fixes d771859. Found alias was on the project's Preview env (NOT demo db): DEMO DEPLOY RECIPE = vercel deploy --yes --token $VERCEL_TOKEN_VISION with every .env.local line as -e AND -b, plus AUTH_URL/NEXT_PUBLIC_APP_URL=https://alphaos-agent.vercel.app and AUTH_TRUST_HOST=true, then vercel alias set. Duplicate buyer mail bug fixed f3e687a (mig 0047 dedupe_key + send claim, test:email-dedupe). Deployed alphaos-l329h96op, aliased; fresh links minted via scripts/login-link.ts (owner@ / tessa@alphaos-demo.test) and tested in a browser. Runner list OK against alias. NEXT: 22:45 UTC real AI sample (seed + sweep without stub), then production landing only on Yousif's go.
2026-09-29 ~23:30 AEST Yousif: "bug test all of this and fix anything, send nothing to customers". Two QA agents (all on demo db, mock mail/print): backend c0bf15c (5 bugs: 2nd proof reminder killed by dedupe key, racing retry burned attempts + false failure card, 2nd failed mail lost its card, wrong AI label after reassign in QC, legacy test capacity; probes a-i all pass incl auth 401s, double-tick, double-confirm, dedupe still lets new events send) + UI e35ac61 (17 bugs: raw JSON in exceptions, busy states on all message buttons, tap targets, tour pointing/wait/skip-empty, signed-out callbackUrl, capacity Full label, etc). Follow-up e243289 (capacity "full" status at source, plain framework label, print blocker copy). All tests pass (print-submit needs a fresh approved demo order, data consumed, known). Deployed alphaos-hj51fl455 -> alphaos-agent.vercel.app (demo recipe), Yousif's links re-verified working (reuse does not revoke). UI QA report + shots: ai-employee-agent var/subtasks/qa-ui-agentfirst/. Still pending: 22:45 UTC real AI sample resume (registered), production landing on Yousif's go.
2026-09-30 09:10 AEST: FIRST REAL AI SAMPLE. Seed now puts the real pet photo in R2 (demo deploy has R2 env, dev store unreachable from Vercel; seed copy at ai-employee-agent var/alphaos-ai-designer/seed-ai-order.ts.txt, run with .env.local + R2_* from alphaos-wt-va). Order AIDEMO-1790722937809 drawn by codex (2 attempts, self-check pass), delivered, awaiting_qc. Runner fixes (ai-employee-agent): JPEG full-res under Vercel 4.5MB body limit, 'name is X' parsing. Demo leftovers: AIDEMO-1790721978261/-1790722065062 failed exceptions, -1790722492430 drawn from the cartoon luna-ref.jpg (not a real photo). Sample sent to Yousif for approval.

---

# VA dashboard simplification (Yousif 2026-10-01, task req4fb55)

Request:
1. VA dashboard = just 3 counts: Awaiting QC, Need a VA reply (complex only), Awaiting print approval.
2. VA side menu = Home, Awaiting QC, Messages, Boards, Print, All Orders Overview (+ keep Designers, Portrait Styles, Customers in More).
3. App faster when changing tabs (preloading).
4. QC: customer photo vs designer portrait; make multiple customer photos obvious.
5. Boards: only designers/boards of the selected business.
6. Awaiting QC page: simpler, more elegant, focused.
Deliver: new VA dashboard on the demo (alphaos-demo.vercel.app), magic link to Yousif. NOT production (he reviews first).

State:
- [x] Branch rebased on origin/main + merged origin/task/alphaos-wt-demofix-req41951 (Tuesday demo fixes) -> HEAD 72f9a07
- [x] Chunk A: VA nav + VA dashboard (sidebar.tsx, bottom-tabs.tsx, staff-home.tsx, lib/home/staff.ts, dashboard/page.tsx)
- [x] Chunk B: QC list page + QC screen multi-photo (app/(app)/qc/*, components/qc/*)
- [x] Chunk C: Boards scoped to selected business (board/page.tsx, lib/designers/roster.ts, designer-rail/picker)
- [x] Chunk D: performance/preloading (next.config.ts staleTimes, app-shell idle prefetch, docs/PERF.md)
- [x] Build + tests, commit
- [x] Deploy demo (scripts/demo/deploy-demo.sh; fix .vercel/project.json to prj_o9jxHFw46R17KuV2V6DkmqaygF3V first; VERCEL_TOKEN_VISION)
- [x] QA desktop+phone on demo as Tessa (VA), magic link, send reply

Facts: demo logins in ~/Documents/ai-employee-agent/.local/alphaos-demo.env. Counts exist in lib/home/staff.ts attention.byKind (qc, reply, print). getRailDesigners has no business filter (the leak Yousif saw).

2026-10-01: all chunks committed, demo deployed (alphaos-k6352f9mf), QA passed desktop+phone (/tmp/alphaos-va-qa/report.json), Tessa link sent. Reply count = all unanswered messages until the agent-first inbox is switched on. Production NOT touched (Yousif reviews first).

2026-10-01 later: gauntlet loops 1-3 + loop 4 done (88 pass / 0 fail, commits b4219e5 6ab8618 45dfa79), demo redeployed, Tessa magic link re-verified (lands on 3-tile dashboard), branch pushed. Known untouched: 14px phone body text app-wide, low contrast on /emails /orders /customers /queue/print /styles. Production NOT touched.

# VA designer management (Yousif 2026-10-01, task req053f1)
Request: VAs add/remove designers + Copy sign-in link for WhatsApp; Portrait Styles tab admin-only (VA sees a card only when a style has no designer); send a no-sign-in designer board link with example data.
State:
- [x] Feature committed: 97b28c2 (+ journal fix 3a5cd84)
- [x] Local next build green
- [x] Links minted: Leo (designer, Northlight ~109 orders), Tessa (VA), 30 days
- [x] Demo deploy green: alphaos-n2mf3xgr0 aliased to alphaos-demo.vercel.app
- [x] Live QA passed: Tessa link signs in, sidebar+phone More have no Portrait Styles, add QA Test Designer -> Create link (Copy button, 90 days) -> Remove all worked live as the VA (RLS 0041 live), Leo link lands on his dashboard/board (10 queue / 40 in design / 2 failed QC example orders), desktop 1440x900 + phone 390x844 snaps in /tmp/alphaos-qa-053f1. Links sent to Yousif (Leo + Tessa, 30 days).
Production untouched.

# req5e549 demo deploy + QA (2026-10-01)
- Migration 0042 applied to DEMO db only (Neon project alphaos-demo, host ep-cool-tree-a7513mu9, owner conn); journal now 50 rows, user.helper_for + enum 'helper' present.
- Demo deploy alphaos-gh8sdrbe0-almacorpvision aliased to alphaos-demo.vercel.app. Prettier fix committed 842200e.
- QA (laptop + phone) in /tmp/alphaos-qa-req5e549: warmed board switch 50-280ms laptop, no skeleton; All Orders 240-420ms client nav; helper sees Board+Help only, pay routes redirect to /board, card open + drag there and back OK. Production untouched.

2026-10-06: fix/designers-business-scope. Designers page and staff Home roster listed every business's designers (getDesignerRoster had no business filter; rail and order-page picker were already scoped). getDesignerRoster now takes the selected businessId and joins designer_businesses; no schema/RLS change. Perfetta workspace shows only Perfetta designers, PixArt only PixArt.

# Owner Approve screen (req f97b5, 2026-10-14)

- From 14 Oct there are no VAs: Yousif and Ayser QC designer work on /approve.
- /approve: one order at a time, every business, urgent first then soonest due. NEW ORDER (photos + order info) or REVISION N (what was asked for, newest first, New/Before toggle).
- Approve = the VA pass + proof email in one tap (all checks ticked, signed with their name); an admin tap also releases an AI portrait held for owner review.
- Reject = touchups note (+ optional check chips, else guessed from the words) -> submitQcFail -> Failed QC on the designer's board.
- Login links take ?next=/approve (safeNext: same-site paths only).
- Nav: Approve after Home on the VA/admin sidebar and phone tabs.
- Status: built + committed; next = staging test, land via integrate:alphaos, send links, 9:00 reminder.

## 2026-10-14 Auto QC (Yousif) task/alphaos-reqea8b3
- Done: migration 0054 auto_qc_checks (tested in a rolled-back tx on prod), lib/qc/auto-qc*.ts, /api/agent-qc/{queue,result}, badge + notes on /approve, /qc cards, /qc/[orderId]; tsc, test:auto-qc, next build green.
- Next: daemon judge scripts/alphaos-auto-qc.mjs (ai-employee-agent), land under integrate:alphaos, first sweep.

# Approve in background + Stop, QC fail pictures, 12 h / urgent 3 h (Yousif 2026-10-14, chat 64828303487194@lid)
Branch task/approve-bg-qcfail in ~/Documents/projects/alphaos-wt-approvebg = merge of 4bdc6cf (approve bg) + 3a73c30 (sla) + 1e5d25d (fail pictures, migration 0055). Agent repo chaser urgent lane pushed (cb934003).
- [x] three streams built, merged, tsc green
- [x] staging deploy + QA (desktop + phone): 3 loops; found+fixed ~6 s hold after Approve/Stop (fc176f6, now ~0.1 s), added instant Alpha message when a failed order turns urgent (3231c09)
- [x] landed 3231c09 on origin/main; prod = CLI deploy dpl_2iM64MqbHL1tv2k8NbC1j9c4hHvm on alphaos-kappa, migration 0055 applied (2026-10-14 13:27 AEDT)
- [ ] reply to Yousif (dot points)

# Two owners on /approve (Yousif 2026-10-14 16:31, chat 64828303487194@lid)
Ask: a link for Ayser to QC too; "me and him can't really overlap in our work or if we do it chooses the one that was first"; Ayser doesn't need to sign in.
- qc_claims (migration 0056, lib/qc/claims.ts): the order on someone's /approve screen is claimed on open, refreshed every 30 s while visible, released on Skip or tab close, lapses after 3 min untouched (locked phone). DB now() only.
- Other owner's queue skips it (getOwnerApproveQueue; Auto QC keeps using getApproveQueue unfiltered); ?o= to a taken order or Skip opens the next free one after it (startIndex), toast "<name> is checking that one".
- First one wins on the server: prepareQcEmailPreview + confirmQcPassAndSend (under the order row lock) + submitQcFail refuse code "claimed" while someone else's claim is fresh; the approve store drops the row with a toast, nothing sent. An approval in its Stop window keeps the hold.
- Header: "<name> is checking N"; All done names who has the last ones.
- Tests: test:qc-claims (pure + DB checks with CLAIMS_DB_URL=staging app_user, 26 ok), test:approve-queue (claimed case). Staging two-person QA (admin laptop + VA phone): 17/17 (/tmp/qa-two-owners/qa.mjs).
- Ayser's existing sign-in link (vault ALPHAOS_LOGIN_LINK_AYSER, not re-minted) + ?next=/approve verified on prod; expiry moved 2026-12-22 -> 2027-01-12 (90 days from today) so it lasts through Christmas.

# Approve buttons on the very bottom (Yousif 2026-10-14, chat 64828303487194@lid)
Ask: "put the buttons on the very bottom for me to press? Not hovering in the middle of the screen?"
- components/qc/bottom-dock.tsx: Approve/Reject (and the reject panel, and the phone Stop row) docked flush to the bottom edge. Phone = fixed over the tab bar (menu button still opens every page); lg = absolute in AppShell's content column (now `relative`), so it follows the sidebar width. Spacer keeps the end of the page clear; height capped 85dvh.
- `--dock-h` on <html> lifts toasts and the desktop Stop stack above the dock; unset on any other page (dashboard toasts unchanged: 80 px phone / 16 px laptop).
- Send-back button reads "Send back" under sm (full label overflowed half a 390 px screen).
- Staging QA (alphaos-staging-dock.vercel.app, admin, desktop 1440x900 + phone 390x844 touch): 41/41 (dock bottom = viewport bottom, column edges both sidebar widths, buttons unobstructed, scroll end clear, reject panel, Stop + toast above dock, dashboard reset). Script: ~/Documents/ai-employee-agent/var/subtasks/alphaos-dock/qa.mjs
- [x] landed acbd9ae on origin/main (merged 329ac55 two-owners first, no conflicts); prod = CLI deploy dpl_EQWZMx162qDVNCG59P1Hx9bPmTy7 on alphaos-kappa (2026-10-14 17:06 AEDT)

# Etsy proof fallback for buyers with no email (Yousif 2026-10-14, chat 64828303487194@lid)
Ask: "For orders that don't have email in alphaOS you should still find a way to send it to them like through Etsy messages: 4197971695 not sent."
- [x] Approve on an Etsy order with no email queues an etsy-channel proof message (address null, proof link in body, metadata delivery=etsy_message reason=no_email) in the same tx as the move to awaiting_approval; proofs.sent_at stays null until the desk confirms delivery
- [x] Gmail outbox, flush, backlog guard, auto-send cap and daily report ignore etsy rows; AI owner hold keeps an etsy draft and the release queues it; non-Etsy no-email = clear ask; /approve row + order timeline say "Etsy message queued"
- [x] test:etsy-proof-queue 39 ok (local bench only); full ci-local bench = the same 8 known failures (7 demo-db suites + security pre-send sign-off); next build green
- [ ] land under integrate:alphaos, prod CLI deploy on alphaos-kappa (worktree .vercel/project.json = prj_o9jxHFw46R17KuV2V6DkmqaygF3V, scope team_hdxl43AlgWsesgr06UyM3Lnk, VERCEL_TOKEN_VISION)
- [ ] agent: the shop desk sends queued etsy proofs as an Etsy message, then marks the row sent (messages.sent_at, proofs.sent_at, activity etsy.sent)
- [ ] reply to Yousif (dot points)

## 2026-10-16 wrong-file stop false refusals (Yousif: "fix it for him so he doesn't have this anymore", designer Jerome)
Branch task/wrongfile-fp, worktree alphaos-wt-wrongfile-fp. Jerome's submits were refused "This file looks like artwork on order 4196318663 / #CPS10287".
- Cause: the 9x8 dHash of a CPS watercolour is mostly the shared paper; about 28% of real uploads came within 10 bits of another order's art. Staff-attached references (old proofs for a revision, art carried over from Trello) also counted as "the customer's photo".
- [x] 33f3b93 second look: 64x80 ink signature (migration 0061 assets.fine_sig); block only when dHash <= 10 AND ink difference <= 0.2; references = customer-sent only. Agent Auto QC got the same two looks (ai-employee-agent c891a886)
- [x] prod: 0061 column applied; backfill hashed the CDN references, then 1021 R2 files (8 unreadable); fine_sig on 543/547 R2 submissions and every hashable reference
- [x] 5d5fdf1 backfill stops before hashing when it cannot read stored files (an inherited R2_* from the agent shell had skipped 1024 files silently)
- [x] proof on prod, every check rolled back: Jerome's 25 uploads and the 4 refused orders' current art all pass; 60 days of artwork vs same-order references = 10 lookalikes, all staff-attached (2 revision proofs, carried-over art on 4196536586 / 4181693839 / cancelled 4196607816, old-proof revision 4189043031, and PC32132's file). PC32132's file now only warns here (landscape on a portrait order); Auto QC's orientation backstop blocks it at QC pass / Approve, and a copy of a sibling's AlphaOS art still blocks (ink 0.000)
- [x] landed 16 Oct 19:23 AEST under integrate:alphaos: main ddd5e64, prod CLI deploy alphaos-r32gndx1j aliased to alphaos-kappa (migration 0061 recorded, live /api/agent-qc/siblings returns fineSig)
- [ ] catch-up hash backfill after landing; Jerome re-presses submit on 4201598491 and 4204380102

## 2026-10-16 Disney routing + designer pay (Yousif 18:42, chat 64828303487194@lid)
Ask: Mar takes no new orders unless over $300 (PixArt BOGO); Wahyu 6 a day across CPS + PixArt, then 1 each to Febri, then Mar; pay $5/figure Disney pet, $1 CPS people / watercolor house / watercolor pet, Jerome $1.50; "how much should Abdul's invoice be this week".
Branch task/designer-pay-2026-10-16, worktree alphaos-wt-designer-pay.
- [x] StyleDailyLimit gains businessIds (one quota across shops), orderTotalOver + currency (value gate: only orders over the amount), newOrdersOnly (a rescue or reassignment does not use up the day's count); the ranker counts today's first assignments per order across the pool
- [x] orders.order_total + order_currency (migration 0062): Etsy rows backfilled from raw_import grandtotal; Shopify import + webhook read totalPriceSet.shopMoney; a reconciled manual order gets its total filled, never overwritten; unknown total never passes a gate
- [x] earnings pay max(style rate, designer_profiles.per_figure_rate floor); a floor never prices an unpriced style
- [x] tests: test:style-quota (day walk: big order to Mar, small ones wahyu x6, febri x2, then mar; rescue not counted), test:limbo (pooled + gated groups), test:earnings (floor cases); full ci-local = the same 8 known failures as base d6b3499 (6 demo-db suites, email-dedupe demo, security pre-send sign-off)
- [x] landed 16 Oct 19:41 AEDT under integrate:alphaos: main 60fd2a3, prod CLI deploy dpl_2oVt13sX3hdpb2YkreFLW5pJyoJU aliased to alphaos-kappa (migration 0062 recorded; 2319/2319 Etsy orders have a total, 7 over AUD 300; Shopify rows wait for the agent backfill)
- [ ] prod data: style rates, Jerome floor 1.50, Wahyu/Febri/Mar groups (snapshots in ai-employee-agent var/alphaos-roster/), open Shopify order totals
- [ ] agent: scripts/designer-invoice.mjs (weekly invoice per designer)

## 2026-10-16 Clean slating P6, AlphaOS part (owner-approved audit fix plan)
Branch task/cleanslate-p6, worktree alphaos-wt-cleanslate-p6. No migrations: new settings live in businesses.agent_config with defaults in lib/agent/config.ts.
- [x] 0962594 item 1, an AI failure goes to a person, confirmed: failJob and a partial multi-portrait delivery call handFailedAiOrder at once; the tick's hand-over (lib/agent/limbo.ts handOverOne) uses the assigner's ranking and closes the card only when the person holds it, AI Studio is off it and their brief is queued
- [x] d6a3c79 item 2, nobody started in 24 h: lib/agent/not-started.ts runNotStartedPass (notStartedMoveHours, assign switch on) moves to the next ranked designer with room, both told on the reassignment road; admin pins, no style and orders already moved twice stay
- [x] a8d0e37 item 3, owner QC open over 12 h: lib/agent/qc-overdue.ts runQcOverduePass sends ONE URGENT to the owner (owner.question, source qc_overdue), then after ownerQcBackupAfterHours the backup approver (qcBackupApproverUserId, else the other owner by 30 days of QC decisions); GET /api/agent-qc/overdue; /approve always shows awaiting_qc
- [x] 73b9fe3 item 4, email approvals: lib/agent/proof-replies.ts runProofRepliesPass (proofReplyDecisions, businesses with the inbox switch off) applies a clear change request or approval; lib/reminders/buyer-replied.ts stops the 3-day reminder, day-5 alert and day-7 auto-approve once the buyer has written, and withdraws stale proof_reminder drafts
- [x] dde9bd5 item 5, archived but unfinished: lib/orders/reopen.ts reopenArchivedOnBuyerWords on Gmail inbound + the tick's catch-all; archivedUnfinishedWhere in the census, rundown, snapshot, GET /api/alpha/order/[id] and GET /api/alpha/archived-open
- [x] 243164a test:agent-autopilot installs the mock transport before tick 1
- [x] landed 16 Oct 19:56 AEDT under integrate:alphaos: main 243164a, prod CLI deploy dpl_5cjnN4X6HTFk8HMD6zg25ncdX9yM aliased to alphaos-kappa; the 20:05-20:47 ticks were HTTP 200 with no errors
- [x] dry runs message nobody: sendAlphaEvent pushed to the hook before commit, so a dry run that rolls back (the /designers/capacity preview on every admin view, the ?dryRun=1 tick, now with the not-started moves in it) could WhatsApp a designer about a move that never happened. withAlphaPushesHeld / holdAlphaPushesIf (lib/alpha/client.ts) around every DryRunRollback site and the whole dry tick; scripts/alpha-hook-recorder.ts counts pushes in test:not-started and test:agent-capacity (removing the guard fails both)
- [ ] land the push hold (prod was down 20:50-22:27 AEDT on the Neon quota; back on the eye lane's dpl_42MK3sxHFGugNPrQsfeyy4gGRsAG)
- [x] real data 19:56-22:36 AEDT (read only): 16 CPS orders decided from the buyer's email reply (11 approved, 5 back to design), 11 archived orders reopened by buyer words (PixArt 9, CPS 2), 4 QC URGENTs to Yousif, 3 orders passed to Ayser as backup approver, no not-started moves
