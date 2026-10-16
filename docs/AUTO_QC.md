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
8. Hands and fingers are anatomically correct (no missing or extra fingers). Every arm ends in a hand (or the hand is hidden the way the photo shows), and two people holding hands show BOTH hands (Yousif 2026-10-14 after 4202169700, see Close look below).
9. Ear shape matches the reference.
10. Number of hands, people and pets is correct. Nothing added, removed or duplicated. Finger count correct. Arms, legs and paws count too.
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

### Close look (Yousif 2026-10-14)

"Make sure these sorts of things are checked in the AlphaOS autoQC moving forward" (4202169700: where the couple
hold hands only her fist was drawn, on his empty cuff, and Auto QC passed checks 8 and 10 as "four hands, all small
but plausible". The judge sees a 4800 x 6000 file at about a fifth of its size.)

- Beside the main judge, a second judge per portrait (and per AI fix image) reads overlapping close-ups cut from the
  ORIGINAL file: 3 x 3 when the long side is 3000 px or more, 2 x 2 from 1500 px. On a full-size file that is more
  than twice the detail of the whole view.
- It is briefed on body parts only: trace every arm to its hand, every handhold (two people holding hands = two
  hands, two thumbs), finger counts, legs and feet, every pet's legs, paws, ears, eyes and tail, held objects, rings
  and lettering only readable up close. A hand hidden the way the photo shows, a customer ask and simplification
  that fits the style are not problems.
- Every place two or more hands meet (a handhold, hands stacked to show a ring, two hands on a box) also gets a blind
  count: a tight full-size crop goes to two judges who are asked only what is drawn there (each sleeve end, thumbs,
  hands), never what should be. A sleeve with no hand of its own, or fewer hands than the photos show, from either
  judge becomes a finding. On a re-run the inspector itself read Eleanor's one fist as two clasped hands; asked only
  to count, the judges saw one fist.
- Every finding gets a second opinion before it counts: a fresh judge, told how the inspector goes wrong (the back of
  a jacket read as a sleeve, a hand given to the wrong arm where arms overlap, a far arm the photo hides too), first
  says what the photos show at that spot in its own words, then checks a full-size crop around it, naming every hand
  and the arm leading into it, and keeps only what it can see itself. If it cannot answer, the findings stand.
  Two blind counts that both came up short are never overruled by that look at the portrait: only photos that show
  no more hands than are drawn clear them (on Eleanor's order the second opinion read the single fist as a clasp again).
  A count finding at a spot where the inspector's own hand finding was kept is dropped, so nothing is said twice.
- Each problem fails check 2, 4, 8, 10 or 12 with a note starting "Close look:" and where it is ("about X% across,
  Y% down"), and makes the verdict `issues`, so the AI fix lane picks it up like any other flag. It never turns a
  fail into a pass; if it cannot answer, the main judge's notes still go out.
- Test it alone, posting nothing: `alphaos-auto-qc.mjs order <n> --dry --close-only`.

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

## Wrong-file stop (incident 16 Oct 2026)

PixArt PC32132 (Saiya alone, portrait) was delivered the PC32131 Parker + Saiya landscape file: the designer put one order's artwork on the buyer's other order. Code: `lib/qc/wrong-file.ts`, hashing in `lib/qc/image-hash.ts` and `lib/qc/asset-hash.ts`, migrations 0060 and 0061.

**Hashing.** Every new upload (designer submission, customer reference, order creation, AI Studio, AI fix) gets a 64-bit dHash (9x8 greyscale), a fine signature (64x80 greyscale, `g64x80:` + base64, migration 0061) plus width and height in `assets.dhash/fine_sig/width/height`. Anything that is not a decodable image (PDF, HEIC where sharp has no decoder, corrupt, too big, fetch failed) gets no hash and is never matched and never blocks. A file with no hash yet (uploaded before 0060) is hashed lazily the first time it is compared.

**Same picture = two looks agree** (`samePicture` in `lib/qc/image-hash.ts`, since 16 Oct): the dHashes at most 10 bits apart AND an ink difference of at most 0.2. The ink difference is the share of inked pixels (more than 20 grey levels off each file's own paper colour, the median of its 2-pixel border) whose ink differs by more than 32 levels. Why: on a shared paper texture the 9x8 dHash is mostly paper, and on 16 Oct it tied about 28% of real uploads (designer Jerome's CPS watercolours, refused as "artwork on order 4196318663 / #CPS10287") to some other order's art. Measured on production files: copies, resizes, JPEG and PNG re-exports 0.000, a 1% crop 0.06 to 0.15, a changed name band 0.12; 364 different pictures the dHash called the same 0.35 to 0.94 (Jerome's 0.80 to 0.83). A missing fine signature is no match (fail-open). One check gives at most 8 files a fine signature on the spot (and saves it): the buyer's other orders first, then the customer photos, then the 100 nearest recent artworks; the backfill does the rest.

**What blocks** (`checkWrongFile(orderId, assetId)` returns `{ blocked, reasons: [{ kind, note, matchAssetId?, matchOrderNumber?, distance?, inkDiff? }] }`):

- `reference`: the file matches one of this order's own customer photos. Only references the customer sent count (`uploaded_by` null: the upload link or an importer). A reference staff attached is often the last proof, given to the designer for a revision that rightly looks like it, so it is never compared.
- `other_order`: the file matches the newest artwork of one of the buyer's other orders.
- `recent_art`: the file matches any artwork in the business hashed in the last 30 days on a different order.
- `auto_qc`: the newest Auto QC row for the file carries `wrongFile` (below).

**What warns only:** `orientation`, when the ordered orientation (line option "Orientation"/"Layout", else notes saying "portrait/landscape orientation") disagrees with the file shape (portrait = h > w * 1.05, landscape = w > h * 1.05). Square-ish files never warn.

**Where it is enforced.** `runTransition` (the single choke point) on every move to Awaiting QC (designer submit) and on `awaiting_qc -> awaiting_approval`; `confirmQcPassAndSend` earlier, before any email goes; the owner Approve (`ownerApproveCore`, the `ownerApprove` action and `POST /api/approve/commit`). Refusal text: "This file looks like PC32131's artwork / the customer's reference photo / artwork on order X. Upload the right file for this order." The system actor (importers, cron) and the AI Studio's own submit skip the hash check; Auto QC covers AI files.

**Override.** Staff (admin, VA) pass `overrideReason` (at least 4 characters): the move goes through and an activity row `order.wrong_file_override` records the reason, the matches and the road. Designers and helpers have no override. In the UI a refusal on /qc or /approve asks staff for the reason in a prompt, then retries.

**Auto QC `wrongFile`.** `POST /api/agent-qc/result` accepts an optional top-level `wrongFile: { kind: reference|other_order|subject_count|orientation|product, note } | null`, stored in `auto_qc_checks.wrong_file`. The badge on /approve and /qc leads with a red "Wrong file: <note>", and Approve is refused while the newest check for that file carries it, unless staff give the override reason. Other unknown values are still rejected.

**Judge helper.** `GET /api/agent-qc/siblings?orderId=<uuid>` (bearer `AGENT_JOBS_TOKEN`) returns `{ orderId, siblings: [{ orderNumber, productLine, stage, newestArtwork: { assetId, url, dhash, fineSig, width, height } | null }] }`. `url` is a signed link valid 10 minutes. No buyer email, surname or address. The judge should fetch it and report `wrongFile` when the file is another order's.

**Backfill (run once after 0060, and again after 0061, is applied; not run by the code):**

```
BACKFILL_DB_URL=<owner connection string> npx tsx scripts/backfill-asset-hashes.ts --dry-run
BACKFILL_DB_URL=<owner connection string> npx tsx scripts/backfill-asset-hashes.ts            # last 60 days
```

Flags: `--days N` (default 60), `--limit N` (default 5000), `--concurrency N` (default 6). It needs the R2 env and hashes newest first; a row missing either the dHash or the fine signature is redone. It stops before hashing anything when it cannot read stored files: an `R2_*` already set in the parent shell wins over `.env.local` and `--env-file` (on 16 Oct the agent's own bucket did, and 1024 files were skipped as unreadable until this check existed).

**Fail-open.** A failed lookup in `checkWrongFile` is logged and reads as "not blocked": it must never stop real work.
