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
- [ ] Chunk A: VA nav + VA dashboard (sidebar.tsx, bottom-tabs.tsx, staff-home.tsx, lib/home/staff.ts, dashboard/page.tsx)
- [ ] Chunk B: QC list page + QC screen multi-photo (app/(app)/qc/*, components/qc/*)
- [ ] Chunk C: Boards scoped to selected business (board/page.tsx, lib/designers/roster.ts, designer-rail/picker)
- [ ] Chunk D: performance/preloading (next.config.ts staleTimes, app-shell idle prefetch, docs/PERF.md)
- [ ] Build + tests, commit
- [ ] Deploy demo (scripts/demo/deploy-demo.sh; fix .vercel/project.json to prj_o9jxHFw46R17KuV2V6DkmqaygF3V first; VERCEL_TOKEN_VISION)
- [ ] QA desktop+phone on demo as Tessa (VA), magic link, send reply

Facts: demo logins in ~/Documents/ai-employee-agent/.local/alphaos-demo.env. Counts exist in lib/home/staff.ts attention.byKind (qc, reply, print). getRailDesigners has no business filter (the leak Yousif saw).
