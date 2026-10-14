# Auto QC (Yousif 2026-10-14)

An AI pass over every order waiting for QC. INTERMEDIATE STEP ONLY: it never
approves, sends, fails or moves an order. It gives the order a badge
"Has been Auto QC'd" plus notes on why it passes or not; Yousif reads it on
/approve and decides himself.

## Yousif's checks (verbatim intent, keys are stable)

1. Portrait style is correct: matches our required style (not too realistic, not too cartoonish, consistent with our examples).
2. Rings and jewellery match the reference photo exactly.
3. All tattoos are present and accurately hand-drawn.
4. Any visible text (clothing, signs, etc.) is correct and legible. No random characters or AI-looking symbols.
5. Eye colour is accurate.
6. Pet fur colour, markings and texture match the reference photo.
7. Hair colour and hairstyle are accurate.
8. Hands and fingers are anatomically correct (no missing or extra fingers).
9. Ear shape matches the reference.
10. Number of hands, people and pets is correct. Nothing added, removed or duplicated. Finger count correct.
11. (Revisions only) The revision was done correctly and fully, no missed touchups.
12. Nothing makes it look obviously AI: no extra or missing limbs, fingers, legs, ears or eyes, fused or melted shapes, warped faces, garbled text, impossible anatomy or objects, odd glossy/plastic skin, mismatched details side to side.

Each check result: `pass` | `fail` | `na` (nothing of that kind in the photos, e.g. no tattoos) | `unsure` (cannot tell from the photos).

## Overall verdict

- `pass`: no check failed (na/unsure allowed, unsure noted).
- `issues`: one or more checks failed.
- `unsure`: the judge could not judge (missing photos, unreadable image). Never shown as passed.

## Data: table `auto_qc_checks` (migration 0054)

| column | type | notes |
|---|---|---|
| id | text pk | |
| business_id | text not null fk businesses | RLS tenant key |
| order_id | text not null fk orders cascade | |
| asset_ids | jsonb not null | sorted array of the version asset ids judged (latest per portrait) |
| verdict | text not null | pass / issues / unsure |
| summary | text | 1-2 plain sentences |
| portraits | jsonb not null | `[{portrait: n or null, assetId, verdict, summary, checks: [{key, label, result, note}]}]` |
| revision | jsonb | null on a new order; else `{done: "yes"/"partly"/"no", missed: string[], note}` |
| model | text | which judge answered |
| created_at | timestamptz default now() | |

RLS: admin + va read (same pattern as qc_checks); writes only via system context.
The newest row whose `asset_ids` equals the order's current latest versions is "current";
an older row means "Auto QC'd an older version, re-check pending".
Every insert also writes an `activity_log` row, action `qc.auto_checked`, from/to state null (so the card feed never reads it as a move; designers never see it), metadata {verdict, issues, autoQcId}. No state change.

## API (bearer AGENT_JOBS_TOKEN, `rejectUnlessAgent`)

`GET /api/agent-qc/queue?limit=10[&order=<orderNumber>]`
Orders in the QC queue (same set as /approve, `getQcQueueIds(..., "all")` semantics, status awaiting_qc)
whose current latest versions have no auto_qc row yet, oldest in QC first. With `order=` returns that
order even if already judged (for re-runs).
```
{ items: [{
  orderId, orderNumber, businessName, shopName,
  style, styleGuessed, figureCount,
  isRevision, round,
  requests: [{ source, text, at }],        // every change request, newest first (same as /approve)
  orderSays: { items: [{title, productType, figureCount, style, options}], personalization, buyerNote, notes },
  references: [{ id, url }],               // buyer photos, presigned
  portraits: [{ portrait: n|null, assetId, url, previous: { assetId, url } | null }],  // latest version per slot; previous = the version before it (revisions)
  assetIds: [..sorted..]
}] }
```

`POST /api/agent-qc/result` body: `{ orderId, assetIds, verdict, summary, portraits, revision, model }`
Refuses (409) when assetIds no longer match the order's latest versions (designer re-uploaded mid-judge).
Returns `{ ok: true, id }`.

## UI

- `/approve` (the owner's QC screen) leads with the badge right under the order heading:
  sage "Has been Auto QC'd · looks right", rose "Has been Auto QC'd · N issues",
  amber "Has been Auto QC'd · couldn't judge", muted slate "Auto QC pending" when none is current.
  Below it, the notes: failed checks first (label + note), then unsure, then a collapsed "passed (n)" list,
  then the revision verdict with missed touchups. 2+ portrait orders show each portrait separately, labelled.
- `/qc` queue cards and `/qc/[orderId]` show the same badge (+ notes panel on the detail page).
- Design tokens only (CLAUDE.md). No new colours.

## Judge (daemon side, not in this repo)

`~/Documents/ai-employee-agent/scripts/alphaos-auto-qc.mjs sweep|order <n>|--dry`, run by the
alphaos-agent-tick (every 10 min, own lock, backgrounded). Vision judge = Claude CLI on the
subscription, Fable first, then Opus, then Sonnet. Never touches order state.
