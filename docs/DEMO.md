# Demo environment

A fully fictional AlphaOS environment for clicking through every function
(QC, orders, designers, proofs, print, emails) without touching production or
staging data. Separate Neon database, separate Vercel URL, its own login
password. Every business, person, order and photo in it is made up; the
image manifest and mock transport mean no real API is ever called.

This is not staging. `docs/STAGING.md` mirrors production data (mocked
integrations); this mirrors nothing, it seeds an invented shop from scratch.

## The two scripts

- `scripts/demo/seed-demo.sh` — stands up (or re-stands-up) the demo
  database: runs migrations, sets `app_user`'s login password, runs
  `seed.ts` → `seed-history.ts` → `seed-qc.ts` under fictional brand/user
  names, then prints a verification table. Idempotent: safe to run again any
  time (migrations only apply what's missing, seeds upsert by deterministic
  id). Refuses to run unless `DEMO_DIRECT_URL` is confirmed (via the Neon
  API) to belong to `DEMO_NEON_PROJECT_ID` — it will never point at
  production or staging.

  ```
  DEMO_ENV_FILE=~/Documents/ai-employee-agent/.local/alphaos-demo.env \
  NEON_API_KEY=<a Neon API key, used only to verify the project id> \
    scripts/demo/seed-demo.sh
  ```

- `scripts/demo/deploy-demo.sh` — deploys the current checkout as a Vercel
  preview wired to the demo database and aliases it to `DEMO_ALIAS`
  (default `alphaos-demo.vercel.app`). Adapted from
  `scripts/staging/deploy-preview.sh`. Not run as part of building this
  tooling; review it before ever running it.

## Where the secrets live

`~/Documents/ai-employee-agent/.local/alphaos-demo.env` (mode 600), never
committed. Holds `DEMO_NEON_PROJECT_ID`, `DEMO_DIRECT_URL` (owner
connection, for migrations/seeds), `DEMO_DATABASE_URL` (app_user connection,
for the running app), `DEMO_APP_USER_PASSWORD`, `DEMO_ENCRYPTION_KEY` (32
bytes as 64 hex chars — the credential-envelope key in
`lib/db/credentials.ts`), `DEMO_ALIAS`, `DEMO_PASSWORD` (the one login
password for every seeded user), and the three seeded email addresses
(`DEMO_ADMIN_EMAIL`, `DEMO_VA_EMAIL`, `DEMO_DESIGNER_EMAIL`).

## Fictional identity

The demo seeds two invented businesses instead of PixArt/Lumina:
**Northlight Portraits** (northlight) and **Paws and Pencils**
(paws-pencils), each with their own fictional Etsy/Shopify shop names and
`.test`/derived email addresses. Six users: an owner/admin, two VAs, three
designers (one spanning both businesses). All identity is overridable by
env (`SEED_BUSINESS_A_NAME`, `SEED_BUSINESS_A_SLUG`, `SEED_BUSINESS_B_NAME`,
`SEED_BUSINESS_B_SLUG`, `SEED_USERS_JSON`, `SEED_PASSWORD`) so `seed.ts`
itself has no hardcoded demo values; `seed-demo.sh` supplies the demo ones.

## Images

`public/demo/manifest.json` (built by `scripts/demo/build-manifest.mjs` from
`public/demo/photos/*.png` and `public/demo/art/<style>-NN.png`) lets
`seed-qc.ts` pick a real generated portrait matching each order's style
instead of a `picsum.photos` placeholder. Deterministic per order id, so
reseeding always shows the same order the same art. Falls back to picsum
automatically if the manifest or its images are missing.

## Reseeding

Just run `scripts/demo/seed-demo.sh` again. It is safe to run repeatedly:
migrations are already-applied-tracked, the `app_user` password ALTER is
idempotent, and every seed script upserts by deterministic id
(`.onConflictDoNothing()`), so re-running never duplicates data. The
verification step at the end fails the run (non-zero exit) if no
`awaiting_qc` order ends up with a submission asset, or if any business is
still named after PixArt.
