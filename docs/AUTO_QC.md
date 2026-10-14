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
13. Resolution (Yousif 2026-10-14: "resolution should at least be 2400 X 3000 px with the ideal being 4800 px X 6000 px in either horizontal or vertical"). MEASURED, never asked of the model: the judge reads the pixel size of the file itself (the original upload, before any resize). Short side >= 2400 and long side >= 3000 = `pass`; under that = `fail` ("ask the designer for the full-size file"); the note says whether it also meets the 4800 x 6000 ideal. A square file needs 3000 x 3000. Code: `resolutionTier` in lib/qc/auto-qc.ts, mirrored in the judge. Applies to every portrait and to every AI fix image. The AI fix never repaints for it (listed under "not fixed").

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

## AI portraits: Auto QC before the owner (Yousif 2026-10-14)

"When you make the watercolor minimal storybook portraits for perfetta, make
sure you still put it through the AlphaOS qc. And through that it should also
go through autoQc check." (Perfetta 4197908493: both revisions were passed
minutes after the AI delivered them, once on the VA login and once by the
agent's own Approve, so Auto QC never judged the second file.)

For an order the AI Studio drew, Auto QC is a gate, not just notes:
`lib/qc/ai-qc-gate.ts` refuses the QC pass until an `auto_qc_checks` row has
judged the exact file going out (or the `auto_qc_fixes` row a sent AI fix came
from has its `qc_verdict`), and refuses any passer who is not an owner. Any
verdict counts (pass, issues, unsure): the owner reads it and decides. On
/approve the Approve and Send AI fix buttons stay shut with a line saying Auto
QC is still checking, and the page looks again every 30 s. The daemon's AI
designer runner asks for the Auto QC of each new drawing right after delivery
(`alphaos-auto-qc.mjs order <n>`), so the wait is minutes. Orders drawn by
people are unchanged.

## Fix samples (Yousif 2026-10-14)

"On top of identifying the problems ... provide a sample where you have gone and changed up the portrait yourself to
fix those things ... make sure not to change anything else ... It should only be a suggestion but if I decide to send
it instead of the designers portrait then that should now be the portrait we work with ... It still needs to run by me
first." Applies to new orders and revisions (missed touchups) alike.

- The agent repaints ONLY the flagged spots of the designer's newest version, at full print size: each spot is
  repainted on a crop by the image model, lined up with the original, and pasted back through a feathered mask of
  what really changed inside that spot's box. Every other pixel is the designer's original. A whole-picture problem
  (wrong style) is listed under "not fixed", never repainted. Before it is offered, a judge checks every spot (fixed,
  blends in, anatomy right, nothing else changed) and the ship judge passes the whole picture.
- Table `auto_qc_fixes` (migration 0057): order, auto_qc_id, source_asset_id (the version painted on), portrait,
  status `ready` | `failed` | `used`, r2_key (`qc-fix/<orderId>/...`), width/height, `fixed`
  `[{keys, label, what, box}]` (box = 0..1 of the picture), `not_fixed` `[{keys, label, why}]`, summary, model,
  engine, used_asset_id, decided_by/at. RLS staff only (designers never read it).
- Agent API (bearer AGENT_JOBS_TOKEN): `GET /api/agent-qc/fix-queue?limit=4[&order=<n>]` (orders in the QC queue
  whose CURRENT Auto QC verdict is issues and that have no fix row for that Auto QC yet; full-size signed portrait
  links), `POST /api/agent-qc/fix-upload {orderId, contentType}` -> `{key, uploadUrl}` (signed PUT, private bucket),
  `POST /api/agent-qc/fix {orderId, autoQcId, sourceAssetId, portrait, status, key, contentType, width, height, fixed,
  notFixed, summary, model, engine}`. 409 when the order left QC or the designer uploaded again. A `failed` row means
  "no clean fix", so the same version is not tried again.
- /approve: an "AI fix" option in the version toggle, the "AI fix ready" panel (each spot zoomed, designer's vs AI fix,
  plus what was not fixed), and a "Send AI fix" button above Reject / Approve designer's. Send AI fix = the same Stop
  window as Approve; the server inserts each fix as the newest `submission` version of its portrait (uploaded by the
  business's AI Studio user), marks the fix `used`, writes `qc.ai_fix_used`, then runs the normal Approve, so the
  proof email carries the fixed portrait and later revisions start from it. Alpha then tells the designer
  (`designer.ai_fix_used`: what changed, that the fixed version is the main file now, a signed link).
- Reject can carry the AI fix as one of its pictures ("Add the AI fix as a picture for the designer").
- STANDING ON EVERY ORDER AND REVISION (Yousif 2026-10-14: "That should be in each and every revision and order"):
  the fix lane runs for every business, on every order AND every revision in the QC queue whose current Auto QC
  verdict is `issues` (a missed touchup fails check 11, so an unfinished revision always qualifies). Nothing is
  sampled or skipped; the sweep works the queue oldest first until every issue order has a fix row (ready or failed).
- AUTO QC JUDGES THE FIX TOO (Yousif 2026-10-14: "The AutoQC should even judge the AI fix too"): every ready fix
  gets its own Auto QC pass, the same checks as the designer's version (migration 0058: `qc_verdict`, `qc_summary`,
  `qc_checks`, `qc_model`, `qc_at` on `auto_qc_fixes`). Endpoints (bearer AGENT_JOBS_TOKEN):
  `GET /api/agent-qc/fix-judge-queue?limit=4[&order=<n>]` (ready fixes with no verdict yet, on orders still awaiting
  QC, whose designer version is still the newest; signed fix + source links plus the full judging context) and
  `POST /api/agent-qc/fix-qc {orderId, fixId, verdict, summary, checks, model}` (notes only, never moves anything;
  writes `qc.ai_fix_checked`). /approve shows the verdict on each fix card: slate "Auto QC of this fix pending",
  sage "looks right", rose "N issues" with the failed checks, amber "couldn't judge". The owner still decides;
  nothing gates Send AI fix.
- Agent side: `~/Documents/ai-employee-agent/scripts/alphaos-qc-fix.mjs sweep|order <n>|--input <job.json> --dry`,
  run by the alphaos-agent-tick after the Auto QC sweep (own lock, backgrounded). Image model: ChatGPT image gen
  (codex, then ChatGPT on the web); never another engine. Each spot's box is re-read on a close-up before painting,
  a change that runs off its crop is repainted once in a bigger area, and the spot judge sees a wider view so a half
  changed thing (half the hair) counts as not fixed. Runbook: knowledge/integrations/alphaos-qc-fix.md (agent repo).
