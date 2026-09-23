# Sign-in links

Each person can hold one private link that signs them in with no typing:

```
<NEXT_PUBLIC_APP_URL>/auth/link/<token>
```

The base link (`/login`) keeps asking for an email and password. Only the
personal link skips it. Opening the link shows a short "Signing you in" card and
lands on `/dashboard`. A link that no longer works shows "This link no longer
works" with a button to the normal sign-in.

## A link is a credential

Anyone holding the link signs in as that person, from any device, until it
expires or is revoked. Send it to the person directly (their own WhatsApp or
email), never to a group chat or a shared document.

- The token is 32 random bytes (base64url, 43 characters). Only its sha256 is
  stored (`login_links.token_hash`), so the full URL is shown once, when it is
  made, and cannot be read back later.
- It works for 90 days and can be used as often as they like until then.
- One active link per person: making a new one stops the old one.
- Failed link attempts count toward the same per-IP limit as failed passwords
  (30 failures in 15 minutes locks that IP out of both).

## Make one

- **Team panel** (admin only): Designers page, "Team and sign-ins", the person's
  "Sign-in link" button, then "Create link" (or "Replace link"). Copy the link
  from the card; it is not shown again.
- **Operator CLI**: `npx tsx scripts/login-link.ts <email> [--days 90]`. Prints
  the URL once. The base is `NEXT_PUBLIC_APP_URL`; pass `--base <app url>` when
  running against production from a machine whose `.env.local` says localhost.

## Stop one

Any of these stops the link at once:

- Team panel: "Sign-in link", then "Revoke link".
- `npx tsx scripts/login-link.ts --revoke <email>`
- Making a new link for the same person.
- Resetting their password.
- Deactivating them (reactivating does not bring the old link back).

Revoking a link stops new sign-ins with it. A session already opened with it
keeps going until they sign out; to end that too, reset their password or
deactivate them (both end every session).

## Where it lives

- Table `login_links` (migration 0039). No row-level security, like
  `login_attempts`: the sign-in reads it before any session exists.
- `lib/auth/login-link.ts`: token, hashing, mint, revoke, `authenticateLink`.
- `lib/auth/index.ts`: the `link` Credentials provider (same user shape as the
  password provider, so the per-request session re-check applies unchanged).
- `app/(auth)/auth/link/[token]/`: the page; `middleware.ts` keeps it public.
- `lib/team/manage.ts` + `components/team/sign-in-link-drawer.tsx`: admin UI.
- Tests: `npm run test:login-link` (part of `test:all`).
