# Security and edge-case QA, 2026-09-23

Staging only (https://alphaos-staging.vercel.app, RLS enforced, app_user).
Evidence (response dumps, probe logs) in `var/e2e-shots/security/` (gitignored).
Fixtures were created on the staging database under ids `5ec09230-*` / `SEC0923`
and removed afterwards.

## Probed

- Every page and API route as designer, VA and signed out (58 requests per role).
- 40+ server actions called directly (ids taken from the client bundles) with
  another designer's order, an unassigned order and random UUIDs.
- Upload and proof token flows: wrong, closed, overlong and SQL-ish tokens;
  wrong file types, 500 MB, 21 files, keys from another order, `..` keys;
  five concurrent approvals, approve twice, revision after approval.
- Cron routes with no, empty and wrong secret; Alpha routes; Shopify webhook
  with unknown shop, bad HMAC, no HMAC and a replayed body; Gelato webhook.
- Login lockout and recovery, sign-out, deactivation, open redirect on
  callbackUrl, CSRF on server actions and sign-out, X-Forwarded-For spoofing.
- Client bundles for secrets and source maps.

## Fixed on this branch

| P | Finding | Commit |
|---|---------|--------|
| P1 | Designer on `/orders/[id]` received the customer's email thread (bodies with addresses), the Etsy buyer's full name and an Email field | d486bc4 |
| P2 | `postComment` on an order the user cannot see threw a 500 | 2c49dc3 |
| P2 | Middleware protected only 7 of 15 app routes; designer/VA denials were streamed redirects with HTTP 200; `/orders/new` and `/orders/[id]/complete` passed the designer allowlist | f2c6a22 |
| P2 | Public upload link showed the storage SDK error name ("UnknownError") to customers | 049c002 |
| P2 | Upload save accepted keys with `..` or sub-paths under the order prefix | 93c2e3d |

## Remaining (not fixed)

- **P1 Revocation.** JWT sessions are never re-checked: after `active=false`
  (or a role change in the database) the old session keeps full access for up
  to 30 days (sliding). Sign-out only clears the cookie; a copied cookie still
  works after sign-out. Proven on staging. Fix: in the Node `jwt` callback
  (`lib/auth/index.ts`) re-read `user.active` and `user.role` (short per-instance
  cache, return `null` when inactive), plus a `sessions_valid_after` column for
  true sign-out invalidation.
- P2 Login is limited per email only (10 fails, 15 min, proven to lock and
  recover). No per-IP limit, so password spraying across accounts is not
  throttled, and anyone can lock out a known email.
- P2 Designer RLS is broader than the UI needs: `messages_select` lets an
  assigned designer read customer emails; `designer_profiles_modify` lets a
  designer update their own rate, rank and capacity (no app path does this
  today); `alpha_events` has no RLS.
- P3 Soft 404s: wrong upload/proof tokens and invisible orders render calm
  "not found" pages with HTTP 200.
- P3 `moveOrder` errors show internal text with the order UUID
  ("not found or not visible in this context").
- P3 Shopify webhook for a shop with empty credentials returns 500 (fails
  closed, but noisy).
- P3 Cron and Alpha secrets compared with `===`, not `timingSafeEqual`.
- P3 `lib/orders/reply-draft.ts` constant imported by a client component pulls
  `lib/db` (Pool, schema) into the order page bundle; no secret values leak
  (env vars are undefined in the browser). Move the constant or add
  `server-only`.
- P3 Proof and upload tokens never expire; presigned PUT does not bind size
  (oversize objects are refused at save but stay in the bucket).
- P3 Manual order `r2Keys` (staff only) are not prefix-checked.
- P3 `/styleguide` is public (static demo content only).

## Held up well

Every server action has a role guard; RLS returned empty, never an error, for
cross-order and random ids; cron routes 401 without the exact secret; proof
decisions are single-winner under concurrency and read-only afterwards; script
tags in notes render escaped (no `dangerouslySetInnerHTML` anywhere);
server actions from a foreign Origin are rejected; sign-out needs the CSRF
token; callbackUrl never leaves the origin; X-Forwarded-For is not spoofable on
Vercel; no secrets or source maps in client bundles.

## Not yet run

Template editor with script tags into email previews, unicode/500-char
customer names, negative/huge figure counts, double-submitting QC pass and
print, concurrent reassignment, notification dropdown and workspace switcher
content, and the review of `0036_user_onboarding.sql` and the send-enable
guard change.

## Verdict on switching production to app_user

Switching makes production safer, not riskier: today production connects as
the owner, so every designer query that relies on RLS (order page, card
detail, comments, uploads) can reach any order and the `customers` table. The
app behaved correctly under enforced RLS on staging. Before or with the
switch: merge the P1 order-page fix, and fix session revocation soon after.
The migration review is still open, so run 0036 on a branch first.
