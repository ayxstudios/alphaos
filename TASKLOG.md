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
2026-09-29: Agent Ph2 inbox: lib/agent/inbox.ts runInboxPass (apply clear approvals/revisions as system actor, draft answers to questions via draftFreeformReply, reply_unclear/buyer_question/unmatched_reply exceptions, proof_reminder drafts), migration 0043 agent_inbox_enabled + agent_config (applied to demo), settings toggle, npm run test:agent-inbox passes on demo (flag reset off). Not pushed.
