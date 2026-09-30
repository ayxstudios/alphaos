# TASKLOG
- branch reset onto demo tip 7b84700, npm ci
- bug2 done: renamed 2 AI Studio users in demo DB (scripts/demo/fix-duplicate-ai-studio.cjs)
- bugs 3-6 + photo TTL coded, committed; next: local built app, deploy, live proof
- bug1: R2 bucket CORS already `*` for GET/HEAD/PUT (no bucket change made); real causes: 5-min presigned GET TTL (now 3600s) + save refusing mis-typed files; live upload flow proven working on ORD-1004
- local BUILT app (next build && next start :3155, demo DB): size field saves to order_items.options, QC "Order says" panel + ORD link + guessed style verified, phone 390 no overflow
- next: deploy-demo.sh once, live verify
- branch pushed to origin (14c2409); .vercel relinked to project alphaos (the earlier link had created a stray empty Vercel project alphaos-wt-demofix-req41951 on the vision team, left untouched); deploy-demo.sh launched, log /tmp/alphaos-demo-deploy.log; next: live verify, wrap-up to Yousif
- DONE 2026-09-30 16:25: demo deployed (alphaos-38bq2umwe, alias alphaos-demo.vercel.app), all 6 fixes verified live; QC orders enriched (enrich-qc-orders.cjs); wrap-up sent to Yousif. Branch task/alphaos-wt-demofix-req41951 pushed, NOT merged (demo only).
