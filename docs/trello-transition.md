# Moving from Trello to AlphaOS

## Recommended strategy

- Old orders stay on Trello. Do not bulk-move them unless you want to.
- When a buyer of an old order emails, or Etsy sends a notice about it, AlphaOS makes a **legacy stub** order (`source = legacy`) and attaches the thread to it. One card appears on **Exceptions**:
  "Order not in AlphaOS yet. Check it on Trello, then confirm the details here."
  Open the card, check Trello, fill the small form (product/style, size, due date, buyer) and press **Confirm order**. The stub becomes a normal order and goes through normal assignment.
- More emails about the same order (same order number, same thread or same buyer) join the same stub and the same card. No duplicates.
- To bring a whole board over at once, use the importer below.
- New orders flow natively (Etsy sync, manual entry). Nothing new should be created on Trello.

## New products

If an incoming Etsy order names a product AlphaOS has no style for (no title or SKU rule, and the shop has no style rule or default style), AlphaOS:

1. creates a catalog row on **Styles** (no designer, AI designer off, flagged as auto-created),
2. holds the order (it is never dropped),
3. opens one card per product: "New product: <title>. Pick who draws it." with a designer picker showing each designer's open count.

Picking a designer gives that designer the style. Waiting orders finish intake on the next agent tick and route automatically, and every future order of the product routes with no card.

Not covered yet: the same check for Shopify orders (the helper `registerUnindexedProduct` in `lib/agent/legacy-intake.ts` is reusable there).

## Trello importer

```
npx tsx scripts/import-trello.ts --business "<name or id>" (--file board.json | --board <boardId>) [--dry-run]
```

- `--file` takes a Trello board export (Board menu, Print and export, Export as JSON).
- `--board` uses the Trello API and needs `TRELLO_KEY` and `TRELLO_TOKEN` in the environment.
- `--dry-run` prints what would be created and writes nothing. Always run it first.
- The database is whatever `DATABASE_URL` points at.

Edit `LIST_TO_STAGE` at the top of `scripts/import-trello.ts` to map your list names to stages
(`awaiting_details`, `awaiting_photos`, `ready_to_assign`, `in_design`, `awaiting_qc`, `awaiting_approval`, `complete`, `on_hold`, or `skip`). Unlisted lists use `DEFAULT_STAGE`.

Mapping of a card:

| Trello | AlphaOS order |
| --- | --- |
| card name | order number (`platform_order_name`) |
| description | notes |
| due | due date |
| labels | line in the notes |
| attachments | links in the notes |
| card id | `trello_card_id` (unique per business) |

Orders get `source = trello`, are flagged for review, and a card already imported is skipped, so re-running is safe. Archived cards and lists mapped to `skip` are left out. Imported orders in a design stage have no assignment; assign them by hand if they are still live.

## Schema (migration 0046)

- `order_source` gains `legacy` and `trello`.
- `orders.trello_card_id` plus a unique index on (`business_id`, `trello_card_id`).
- `styles.auto_created` and `styles.listing_title`.

Test: `npm run test:legacy-intake` (demo database).
