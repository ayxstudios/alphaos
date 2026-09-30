// Demo DB only (DEMO_ENV_FILE): the two seeded QC orders carried no listing
// title, size option or personalization, so the VA "Order says" panel only
// showed fallbacks and a VA could not check the art against the description.
// Give ORD-1003 and ORD-1002 realistic order data (never deletes). Idempotent.
const { neon } = require("@neondatabase/serverless");
require("dotenv").config({ path: process.env.DEMO_ENV_FILE });
const sql = neon(process.env.DEMO_DIRECT_URL);
const data = {
  "ORD-1003": {
    title: "Custom Pet Portrait from Photo, Watercolor Style Dog Cat Print",
    size: '11x14"',
    personalization: "Biscuit (golden retriever), add a red bandana please",
    buyerNote: "He has a small white patch on his chest, please keep it!",
  },
  "ORD-1002": {
    title: "Family Portrait Illustration from Photo, Line Art Couple Print",
    size: '8x10"',
    personalization: "Sam and Priya, wedding date 14.06.2025 under the drawing",
    buyerNote: null,
  },
};
(async () => {
  for (const [num, d] of Object.entries(data)) {
    const orders = await sql.query(`select id, raw_import from orders where platform_order_name = $1 or platform_order_id = $1`, [num]);
    if (!orders.length) { console.log(num, "not found"); continue; }
    const o = orders[0];
    const raw = Object.assign({}, o.raw_import || {});
    raw.transactions = [Object.assign({}, (raw.transactions || [])[0] || {}, {
      title: d.title,
      quantity: 1,
      variations: [
        { formatted_name: "Size", formatted_value: d.size },
        { formatted_name: "Personalization", formatted_value: d.personalization },
      ],
    })];
    if (d.buyerNote) raw.message_from_buyer = d.buyerNote;
    await sql.query(`update orders set raw_import = $1 where id = $2`, [JSON.stringify(raw), o.id]);
    const items = await sql.query(
      `update order_items set title = $1, options = $2 where order_id = $3 returning id`,
      [d.title, JSON.stringify([{ name: "Size", value: d.size }]), o.id],
    );
    console.log(num, "updated items:", items.length);
  }
})();
