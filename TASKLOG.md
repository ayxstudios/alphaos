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
