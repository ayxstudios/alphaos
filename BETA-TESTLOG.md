# AlphaOS Beta Tester Log

Branch: `beta-debugger/polish-2026-08-10`. Workflow B (test + fix in one pass).
Started 2026-08-10 (AEST). Never pushed/merged to main.

## Phase 0/1 — Setup (done)

- Cloned `ayxstudios/alphaos` (main @ a4aaf8a) into
  `~/Documents/projects/alphaos`, branch created.
- Read: `CLAUDE.md`, `AGENTS.md`, `docs/README.md`, `docs/HANDOFF.md`,
  `docs/PROGRESS.md`, `docs/GMAIL_SETUP.md`, `.env.example`, the MVP brief
  (Google Drive). Full route map built from `app/` tree (below).
- **Test environment: an isolated Neon Postgres DB was provisioned
  specifically for this beta test** (via `vercel integration add neon`
  under this agent's own Vercel team, project `almacorp/alphaos`), NOT the
  real production database. Migrations + RLS (`app_user` role) applied.
  Reason: CRUD/auth/QC/proof-portal testing needs to freely create, edit,
  and delete orders — doing that against the real 2,000-orders/month
  production DB would risk visible corruption of live business data. This
  keeps the hard "real data stays read-only" rule intact while still
  allowing a genuine, full-depth functional test.
- Seeded via the project's own `npm run db:seed`: 2 businesses (PixArt,
  Lumina), 6 users (1 admin, 2 VA, 3 designer), 4 shops, 11 customers, 20
  orders across all statuses (some overdue, some due soon), 14 active
  assignments. Login: `admin@aystudios.io` / `alphaos123` (matches the
  real prod credentials given by the user, by the seed script's own
  design — safe here since this is the isolated test DB only).
- `npm install`, dev server boots clean (`npm run dev`, ready in 2.5s,
  `/api/health` returns `{"status":"ok"}`).

### Known gaps going in (from docs/PROGRESS.md, confirmed by reading code)

- Etsy integration: never made a live call against a real Etsy account.
- Gmail email layer: no business has connected Gmail live.
- Print provider (Lumaprints/Gelato) API: not wired, manual tracking-entry
  path only.
- Earnings/payout reporting UI: `earnings` are written on completion, no
  report screen yet.
- 48h photo reminder + background SLA/overdue sweep: not built (overdue is
  read-time only).

### Credentials/access this agent does NOT have (flagged, not fabricated)

- No Cloudflare R2 credentials → cannot test the real file-upload path
  end-to-end (manual order entry drag-drop, designer submission upload).
  Will test the UI/validation around it and note this gap explicitly in
  the report rather than claim it works.
- No `ANTHROPIC_API_KEY` → Auto-QC button cannot be live-tested.
- No real Etsy/Shopify/Gmail OAuth credentials → those connect flows can
  be UI-tested (does the form appear, validate, etc.) but not completed
  end-to-end. Matches the known-untested surface above.
- Asked the user (2026-08-10) whether to provide any of these; proceeding
  with everything else in the meantime rather than blocking.

## Route map (from `app/` tree) — testing checklist

- [ ] `(auth)/login` — login, wrong password, session persistence
- [ ] `(app)/dashboard`
- [ ] `(app)/board`
- [ ] `(app)/queue`
- [ ] `(app)/orders` (list)
- [ ] `(app)/orders/new`
- [ ] `(app)/orders/[id]` (detail)
- [ ] `(app)/orders/[id]/complete`
- [ ] `(app)/customers`, `(app)/customers/[id]`
- [ ] `(app)/designers`
- [ ] `(app)/qc`, `(app)/qc/[orderId]`
- [ ] `(app)/settings`
- [ ] `(app)/styles`
- [ ] `/proof/[token]` (public customer proof portal)
- [ ] `/styleguide`
- [ ] Role coverage: repeat key flows as VA and as Designer, not just Admin

## Findings

(populated as testing proceeds)
