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
