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
