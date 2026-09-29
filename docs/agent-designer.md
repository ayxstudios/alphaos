# AI designer (agent designer) backend

An outside agent draws portraits for products that have the AI designer
switched on. AlphaOS holds the queue; the agent polls it over a small
bearer-token API. Everything after delivery is the normal flow (VA QC, proof
email, buyer approval or revision).

## Setup

- Env: `AGENT_JOBS_TOKEN` (a long random string). Set it in `.env.local` and in
  the Vercel project env. With it unset every call returns 401 (fails closed).
  Callers send `Authorization: Bearer <token>`.
- Per product: `styles.ai_designer_enabled` (boolean) and `styles.ai_framework`
  (text, the drawing recipe, e.g. `pixart-disney-pet`). There is no Styles page
  toggle yet; use `setStyleAiDesigner` in `lib/agent/ai-designer.ts` or SQL.
- One "AI Studio" designer per business (`designer_profiles.is_agent = true`).
  Migration `0045_ai_designer` creates them. Humans-only logic (capacity,
  auto-assign candidates, roster, designer reminders) excludes it.
- Settings > Agent has `Send my email replies automatically`
  (`autoSendReplies`, default on) and `I approve each AI portrait before it goes
  out` (`aiOwnerApproval`, default on).

## Flow

1. Intake: an order whose style has the AI designer on is assigned to the
   business's AI Studio designer and `orders.ai_state = 'queued'`.
2. `GET jobs` lists it. `claim` moves it to in design (`ai_state 'claimed'`).
3. `deliver` stores the portrait as a `submission` asset, moves the order to
   VA QC, logs activity `ai.delivered` with the `selfCheck`.
4. A VA passes QC in the normal screen. With `aiOwnerApproval` on, the order
   moves to awaiting approval but the proof email stays a held draft
   (`ai_state 'owner_review'`). `listOwnerReview(businessId)` lists them;
   `approveOwnerReview(orderId, adminUserId)` sends the email and marks the
   proof sent. With the setting off the email goes out at QC pass as usual.
5. Revision (buyer or QC fail): the order goes back to the jobs queue as a
   `revision` job (`ai_state 'revision'`), never to a human board. Activity
   `ai.revision_queued` has `metadata.stage = 'in revision (AI)'`. After
   `deliver` it re-enters VA QC.
6. `fail` raises an exception card (`ai_designer_failed`); the order stays
   with the agent (`ai_state 'failed'`, out of the queue) until someone runs
   `reassignOrder`.

`ai_state` values: queued, claimed, revision, revision_claimed, qc,
owner_review, with_buyer, failed.

`reassignOrder(orderId, designerId, byUserId)` (lib/agent/ai-designer.ts) is the
single reassign path for any order. Moving away from the agent clears
`ai_state` and removes it from the queue; moving to the agent queues it.

## API

All under `/api/agent-designer/jobs`, JSON in and out. Errors are
`{ "error": "<code>", "message": "..." }` with 400/401/404/409/413/502.

`GET /api/agent-designer/jobs` returns `{ "jobs": Job[] }`:

```json
{
  "jobId": "<order id>",
  "kind": "new | revision",
  "orderId": "...",
  "orderNumber": "#1234",
  "business": { "id": "...", "name": "Paws and Pencils" },
  "product": { "title": "...", "style": "Disney Pet", "aiFramework": "pixart-disney-pet", "productType": "digital" },
  "size": "8x10" ,
  "variant": [{ "name": "Size", "value": "8x10" }],
  "figureCount": 1,
  "buyerPhotoUrls": ["https://..."],
  "buyerNotes": "text or null",
  "revision": null,
  "state": "queued | revision",
  "dueAt": "ISO or null",
  "queuedAt": "ISO"
}
```

For a revision job `revision` is
`{ "number": 1, "source": "buyer | qc", "buyerWords": "exact words", "issues": ["..."], "priorPortraitUrl": "https://..." }`.

`POST /jobs/{id}/claim` returns `{ "ok": true, "job": Job }`. 404 if the order is
not held by the AI designer, 409 if it is not waiting (already claimed).

`POST /jobs/{id}/deliver` body: exactly one of `url` (http/https) or `base64`
(raw or data URL; optional `contentType`, `filename`; jpeg/png/webp/gif, 25 MB
max), plus required `selfCheck` (what you checked against the photos and brief).
Returns `{ "ok": true, "orderStatus": "awaiting_qc", "assetId": "..." }`. 409 if
the job was not claimed first.

`POST /jobs/{id}/fail` body `{ "reason": "..." }` returns
`{ "ok": true, "exceptionId": "..." }`.

## Tests

`npm run test:ai-designer` (demo database only). Covers enable, intake, job
listed, claim, deliver, VA QC, owner approval, revision, deliver again, fail,
reassign away, and the HTTP auth layer. It leaves the Paws and Pencils
`Disney Pet` style enabled with framework `pixart-disney-pet`.
