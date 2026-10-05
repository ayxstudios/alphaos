# Onboarding a business

Standing rule (Yousif 2026-10-06): every fix and improvement is made at the
platform level, never per business. If a fix only works for one business it is
not done. New and existing businesses are held to one shared baseline, checked
by `npx tsx scripts/onboard-business.ts audit [slug]`.

## Why fixes propagate automatically

- All behaviour lives in shared code paths scoped by `business_id` (RLS).
  There are no per-business code branches except email-template wording,
  which is a data override (`email_templates` rows) on top of generic
  `{{business_name}}` defaults in `lib/email/templates.ts`.
- Migrations change every tenant at once; demo/one-off data scripts live in
  `scripts/demo` and never encode a fix.
- Cutoffs (`agent_config.agentFrom` / `todoFrom`), personas (`replySignOff`),
  signatures, styles, rates, designer links and credentials are per-business
  DATA, set once at onboarding — they are configuration, not fixes.
- QC sign-off names come from the live active VA/admin team, never a
  hard-coded list.

When writing a fix: if you are tempted to check a business slug, stop and move
the difference into `agent_config`, a business column, or a data override.

## New business

1. `npx tsx scripts/onboard-business.ts create --name "Acme Portraits" --slug acme`
   (sets `agentFrom`/`todoFrom` to now by default so history never floods the
   queues; every customer-facing switch starts OFF).
2. In Settings: connect the shop(s); connect the business's own Gmail OAuth
   (own Google Cloud project per business — docs/GMAIL_SETUP.md); print
   credentials; portrait styles with per-figure USD rates and a default;
   link designers; reply persona + email signature.
3. Review email templates; the generic defaults send until overridden.
4. `npx tsx scripts/onboard-business.ts audit acme` until it prints
   "Baseline complete."
5. Only then flip, deliberately and per business: `email_sending_enabled`,
   stage auto-send, agent gates (docs/AGENT_FIRST.md).

## Existing businesses

Run `npx tsx scripts/onboard-business.ts audit` after any onboarding-shaped
change; each `!!` line is an unfinished baseline item for that business.
