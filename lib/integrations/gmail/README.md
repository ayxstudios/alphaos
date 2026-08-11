# Gmail integration

Per-business customer email over the Gmail API. Each of the businesses connects
its **own** Google Cloud project + OAuth client (Internal user type), and sends
from its **own** `orders@` mailbox. We never use SMTP and never a shared/
transactional provider.

## Files

- `oauth.ts` — Google consent URL, code→token exchange, refresh, signed state cookie
- `client.ts` — `GmailClient.forBusiness(businessId)`: access-token refresh under a
  row lock, exponential backoff, structured logging (`integration: "gmail"`); `send`,
  `getProfile`, `listHistory`, `getMessage`. `markGmailConnected` stores the mailbox
  address + history cursor.
- `mime.ts` — RFC 2822 multipart/alternative builder; inbound header/plain-text parsing
- `inbound.ts` — `pollMailbox` / `pollAllMailboxes`: read history since the stored
  cursor, attach inbound replies to the matching order by `gmail_thread_id`, notify
  VAs, and log to the order timeline. Scheduled by Vercel Cron through
  `/api/cron/gmail-poll`.

## Credentials

Stored encrypted per business in `businesses.gmail_credentials` (AES-256-GCM,
`ENCRYPTION_KEY`) via `getBusinessGmailCredentials` / `setBusinessGmailCredentials`.
Non-secret bits (`gmail_address`, `gmail_history_id`) are plain columns.

## Admin: connecting the first business

See the step-by-step Google Cloud Console setup in the settings UI / the build
notes. In short: create a project, enable the Gmail API, configure an **Internal**
OAuth consent screen, create an OAuth **Web application** client with redirect
`${NEXT_PUBLIC_APP_URL}/api/gmail/callback`, paste the client id/secret + `orders@`
address into Settings → the business's Gmail card, then click **Connect Gmail**.
