# Gmail setup — per business

AlphaOS sends customer email through **each business's own Gmail mailbox** over
the Gmail API (never SMTP, never a shared/transactional provider). Every business
gets its **own** Google Cloud project + OAuth client (Internal user type). Repeat
this checklist once per business — 14 in total.

Before you start, have ready for the business:

- Admin access to that business's **Google Workspace**.
- The sending mailbox, e.g. `orders@yourbusiness.com`.
- The app's **redirect URI** — Settings shows it per business as
  "Redirect URI to whitelist". It is `NEXT_PUBLIC_APP_URL` + `/api/gmail/callback`,
  e.g. `https://app.yourdomain.com/api/gmail/callback` (local dev:
  `http://localhost:3000/api/gmail/callback`).

---

## Steps

1. **Sign in** to <https://console.cloud.google.com> as an **admin of that
   business's Google Workspace** — not your personal Google account.

2. **Create a project.** Top-bar project dropdown → **New Project** → name it
   e.g. `AlphaOS – <Business>` → **Create**, then select it.

3. **Enable the Gmail API.** Left menu **APIs & Services → Library** → search
   **Gmail API** → **Enable**.

4. **Configure the OAuth consent screen.** **APIs & Services → OAuth consent
   screen** → **User type = Internal** → **Create**. Fill in App name (e.g.
   `AlphaOS`), User support email, and Developer contact email → **Save and
   Continue**. Internal type means no Google verification/review is required.

5. **Scopes.** Leave empty and continue — the app requests the scopes it needs at
   runtime (`gmail.send`, `gmail.readonly`). Save and continue.

6. **Create the OAuth client.** **APIs & Services → Credentials → Create
   Credentials → OAuth client ID** → **Application type = Web application** →
   name it. Under **Authorized redirect URIs** click **Add URI** and paste the
   redirect URI **exactly** (copy it from the business's Settings card):

   ```
   https://YOUR-APP-DOMAIN/api/gmail/callback
   ```

   → **Create**.

7. **Copy the Client ID and Client secret** from the dialog.

8. **In AlphaOS.** Go to **Settings**, select the single business in the top bar,
   open the **Customer email (Gmail)** card, and paste the **Client ID**, **Client
   secret**, and the sending address (`orders@yourbusiness.com`) → **Save client**.

9. **Connect.** Click **Connect Gmail** → sign in as the sending mailbox (or an
   account that can send as it) → approve. You return to Settings showing
   **Connected**.

10. **Verify.** Click **Check for replies** on the card to run the inbound poller
    once and confirm the connection end-to-end.

---

## Notes & gotchas

- **Authorize as the sending mailbox.** Google sends "from" the account that
  approves consent. If `orders@` is a shared/group address, authorize with an
  account that owns it (or has send-as configured for it).
- **Redirect URI must match exactly**, including scheme, host, and no trailing
  slash. A mismatch is the most common cause of `redirect_uri_mismatch` on connect.
- **Refresh token.** The connect flow uses `access_type=offline` + `prompt=consent`,
  so Google always returns a refresh token. If a business ever shows **Needs
  re-auth**, just click **Connect Gmail** again.
- **One project per business.** Do not reuse a single OAuth client across
  businesses — credentials are stored and scoped per business.
- **Templates.** After connecting, edit the three per-business email templates
  (Photo request, Proof ready, Revision received) in the same Settings section.
  They render server-side and can be changed without a deploy.
