# TASKLOG
- branch reset onto demo tip 7b84700, npm ci
- bug2 done: renamed 2 AI Studio users in demo DB (scripts/demo/fix-duplicate-ai-studio.cjs)
- bugs 3-6 + photo TTL coded, committed; next: local built app, deploy, live proof
- bug1: R2 bucket CORS already `*` for GET/HEAD/PUT (no bucket change made); real causes: 5-min presigned GET TTL (now 3600s) + save refusing mis-typed files; live upload flow proven working on ORD-1004
- local BUILT app (next build && next start :3155, demo DB): size field saves to order_items.options, QC "Order says" panel + ORD link + guessed style verified, phone 390 no overflow
- next: deploy-demo.sh once, live verify
