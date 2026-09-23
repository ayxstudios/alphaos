# Security and edge-case QA, round 2, 2026-09-23

Staging only (https://alphaos-staging.vercel.app, RLS enforced, app_user, mock
integrations armed). Production and its database were not touched; production
env vars were read as key names and mock-prefix booleans only. Evidence (probe
output, response dumps, the probe scripts) in `var/e2e-shots/security-r2/`
(gitignored). Fixtures were own users and orders under `5ec2a230-*` / `SECR2`,
removed afterwards (0 left). Round 1: `docs/QA-2026-09-23-security.md`.

Staging still runs the pre-fix build (nothing was deployed). Each finding
below was reproduced on staging or, for the RLS and relay items, locally, and
each fix is covered by a local suite (`scripts/ci-local.sh`); re-run the
staging probes after the next preview deploy.

## Probed

1. Round 1 fixes and the new revocation: designer order page and card (no
   customer email, thread or last name), middleware for 19 pages as signed
   out, designer and VA, `..` upload keys, postComment on a hidden order,
   copied cookie after sign-out, deactivation, DB role change, admin password
   reset (two devices), last admin, team actions called by hand as VA and
   designer, team actions with hand-edited types.
2. Input hardening: 12 SQL-ish / HTML-ish / NUL / RTL / 5000-char payloads
   against `/orders`, `/customers`, `/emails` search (VA) and `/board` search
   (designer); template editor with script tags (settings page, QC preview,
   email HTML); customer names in unicode and 500 / 5000 chars; figure counts
   -5, 0, 2.7, "3", 1e6, 2147483647, 1e10; Pass QC and send twice
   concurrently; three concurrent print starts; four concurrent reassignments
   of one order (in design and ready to assign).
3. Shell: notification dropdown with HTML and a `javascript:` href in a
   notification, workspace switcher with a forged business id, Ask Alpha
   (widget route and order action) with the relay off, client bundles of
   admin, VA, designer and signed-out pages (32 chunks) for `postgres://`,
   `sk-`, `shpat_`, `shpss_`, `ENCRYPTION_KEY`, `AUTH_SECRET`, `CRON_SECRET`,
   `npg_`, `mock_`, `MOCK_INTEGRATIONS`, R2 keys, PEM, source maps.
4. Migrations 0036, 0037 and the send-enable backlog guard (read).
5. Per-IP login limit (built and tested locally).
6. Every RLS policy after 0000 to 0037 against the queries each role runs.
7. Mock safety: instrumentation, transport matching, print mock switches,
   production env on Vercel.

## Fixed on this branch

| P | Finding | Commit |
|---|---------|--------|
| P2 | Reactivating a user brought their pre-deactivation cookies back (copied cookie: session and board again after reactivation). `setMemberActive` with `active: "no"` skipped the last-admin guard while Postgres stored false. | f32e55f |
| P2 | (Round 1) Login limited per email only: password spraying across accounts not throttled. Now also 30 failures / 15 min per IP (`x-forwarded-for`), failures only. | afda2aa |
| P2 | Pass QC and send clicked twice sent the customer two proof emails (mock mailbox: 2 sent, 1 transition). A wrong sign-off sent the proof, then the transition refused, and every retry sent another (3 emails, order still awaiting QC). | 41f80b6 |
| P2 | Proof email HTML: quotes not escaped, so customer text in a URL (first name `https://x/"onmouseover="...`) broke out of `href` in the sent email. Script tags were escaped. | 1c5e656 |
| P2 | Manual order figure count unbounded (1,000,000 and 2,147,483,647 stored; pay is per figure); 1e10 returned drizzle's `Failed query: insert into "order_items" ...` with all bound values to the browser. | fc6da3e |
| P2 | Nothing in code refused mocks on production, and docs/MOCK.md said to set the switches on production. `PRINT_PROVIDER_MOCK=1` there would fake shipped tracking for real order numbers. Production env itself is clean (below). | 7c97027 |
| P2 | Ask Alpha: `/api/alpha/chat` forwarded any `orderId` and `/orders/<id>` page path from the browser to the relay (which reads orders with system access); `askAlphaAboutOrder` passed the raw id on even when RLS hid the order. Relay is off on staging, so not exercised live. | 0916088 |
| P2 | (Round 1) RLS: `messages_select` let an assigned designer read the customer's email thread; `designer_profiles_modify` let a designer set their own rank, rate and capacity. Both staff only (migration 0038). | d6b2136 |

Tests: `test:team` (+2), new `test:security` (15 checks), `test:rls` (+2,
fail on 0037, pass on 0038).

## Re-verified on staging (held)

- Round 1 P1: designer order page and loadCard carry no customer email,
  thread body or last name. Middleware: signed out 307 to /login on all 19
  pages; designer reaches only dashboard, board, help, me (the rest 307 to
  /board); VA 307 to /dashboard on payouts and health. `..` upload key refused;
  postComment on a hidden order is a calm "Order not found".
- Revocation: copied cookie dead after sign-out (session null, /board 307,
  server actions 307); deactivated user refused on the next request and cannot
  sign in; DB role change ends the session; admin password reset ends both
  devices, old password fails, new works. Last admin: refused (local suite;
  not done on shared staging). VA and designer calls to addTeamMember,
  setMemberActive, resetMemberPassword, addDesigner all refused, nothing
  written.
- Search: all 48 payload requests 200, parameterised, nothing echoed raw.
- Template editor: script tags stored as text, escaped on the settings page
  and in the email HTML (`&lt;script&gt;`).
- Print: three concurrent starts, 1 print job, 1 transition (row lock).
- Reassignment: always exactly one active assignment (unique partial index).
- Shell: no customer emails in designer pages, notification title/body
  escaped, forged business cookie falls back, chat 401 signed out, 400 on bad
  JSON, relay off answers from the caller's own snapshot only.
- Bundles: no secrets, no connection strings, no source maps; `shpat_` only as
  a placeholder string.

## Migration safety (part 8)

- `0036_user_onboarding.sql` and `0037_session_revocation.sql`: one
  `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS`, nullable, no default each.
  Idempotent, catalogue-only (no rewrite, no data change), a lock of
  milliseconds on a 1-row table. Existing sessions keep working (null
  `sessions_valid_after`).
- `0038_rls_designer_tighten.sql` (this branch): DROP/CREATE POLICY only,
  idempotent (applied twice locally), brief lock on `messages` and
  `designer_profiles`. No effect on production until it runs as app_user.
- Send-enable guard (`lib/email/backlog-guard.ts`): no schema change; in the
  same transaction as the switch, stale queued/draft system emails become
  drafts with `metadata.skippedOnEnable`; nothing deleted, re-run skips
  already marked rows. Row by row, trivial at 121 orders.

## Mock safety (part 7)

- Production env (Vercel API): no `MOCK_INTEGRATIONS`, no
  `PRINT_PROVIDER_MOCK`, no `ANTHROPIC_*` key; 0 of 37 production values start
  with or contain a mock prefix.
- The transport installs only from `instrumentation.ts` (Node runtime,
  `MOCK_INTEGRATIONS=1`); no route or client code imports `lib/mock`. It
  patches `fetch` and answers only anchored prefixes: `shpat_mock`, `mock_`
  (Etsy key, Anthropic key), `Bearer mock_` (Gmail); OAuth bodies by substring
  `refresh_token=mock_` / `client_id=mock_`. Real formats (`shpat_` + hex,
  `1//`, UUID Gelato keys, 24-char Etsy keys, `sk-ant-`) cannot match.
- Now also refused when `VERCEL_ENV=production` (transport and both print
  clients). Production DB credentials were not read (out of bounds);
  `arm-mocks.ts` refuses the production endpoint.

## Remaining P2 (not fixed, need a design call)

RLS policies wider than the app uses (defence in depth: no app path uses the
extra access today; production enforces none of it until the app_user switch):

- `"user"` has no RLS and app_user may UPDATE it: a designer context could set
  its own `role`. SELECT must stay open (login and session re-check read it
  with no GUCs). Proposal: RLS on, `SELECT true`, INSERT/DELETE admin,
  UPDATE admin or own row `WITH CHECK (role::text = app_role())`.
- `designer_businesses` has no RLS: a designer context could attach itself to
  another business (opening its shops and `customer_public`). Needs a check of
  every cron path that reads it on the raw handle before enabling.
- `alpha_events` has no RLS; VA inserts need SELECT (`.returning`), and a
  designer Start may emit a brief event through `sendDesignerBrief`, so a
  staff-only insert policy is not clearly safe.
- `activity_log_insert` and `assets_designer_insert` accept any `actor_id` /
  `uploaded_by` / asset type for a designer's business; `customer_public`
  shows first names of every customer in the business; designers may DELETE
  notifications and use `notification_channels`; `account`, `session`,
  `verification_token` are granted though unused (JWT sessions).
- `orders_designer_update` allows any column (a policy cannot limit columns;
  needs a trigger); `orders_select` lets a designer read `raw_import` (Etsy
  `buyer_email`), which the order page uses server-side for the first name;
  `shops_select` returns encrypted credentials to designers.
- VA policies are FOR ALL: VAs may DELETE orders, customers, messages,
  assignments, proofs, print jobs, assets and edit earnings; no VA path does.

## P3 (logged)

- `/customers?q=%00` renders the error boundary (HTTP 200, digest only).
- Concurrent reassignment: the losers get HTTP 500 (unique index violation)
  instead of a calm "someone just reassigned this".
- `addTeamMember` with a non-string name returns 500 (digest only).
- Customer names have no length cap (5000 characters stored; pages render).
- Search `%` and `_` are not escaped (a lone `%` matches everything; staff
  only).
- Notification `href` goes to `router.push` without a leading-`/` check
  (server-written paths only today).
- The built-in `POST /api/auth/signout` clears the cookie but does not revoke;
  the app's own sign-out (`signOutAction`) does.
- `recheckToken` keeps a session when the database read fails (deliberate).
- A designer calling team actions gets HTTP 200 `{}` (refused, no write)
  instead of the calm message VAs get.
- The order page client chunk still bundles `lib/db` (Pool, schema) because
  `components/orders/reply-draft.tsx` imports `REPLY_TEMPLATE_OPTIONS` from
  `lib/orders/reply-draft.ts`. No secret reaches the browser: only
  `NEXT_PUBLIC_*` env is inlined, `process.env.DATABASE_URL` is undefined
  there, and the bundle grep finds only the Neon driver's format strings. Fix:
  move `REPLY_TEMPLATE_OPTIONS` / `BLANK_TEMPLATE_KEY` into a db-free module.
- `prepareQcEmailPreview` trusts the client checklist (the send now runs the
  authoritative gate).
- Round 1 P3s still present: `moveOrder` not-found message includes the order
  UUID; hidden orders are soft 404s (HTTP 200).
- Seen by the RLS review: a designer's Start never drafts the `in_design`
  stage email (the helper reads `customers`, hidden from designers).

## Verdict

Go for production once this branch is merged and deployed (vercel-build
applies 0038). No P1 found; every P2 that exposed data, sent duplicate
customer email or leaked errors is fixed and covered. Switching production to
app_user stays the safer state. The remaining RLS P2s are defence in depth
and can follow.
