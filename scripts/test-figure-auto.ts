import assert from "node:assert/strict";
import { inferItemFigureCount } from "../lib/orders/figure-auto";

const receipt = (variations: { formatted_name: string; formatted_value: string }[], note?: string) => ({
  message_from_buyer: note ?? null,
  transactions: [{ transaction_id: 1, title: "Pet portrait", quantity: 1, variations }],
});
const base = { options: null, config: null, itemCount: 1 };

// option on the item itself
assert.equal(inferItemFigureCount({ ...base, rawVariations: [{ name: "Number of Pets:", value: "2" }], rawImport: null })?.count, 2);
// only the stored receipt knows
assert.equal(
  inferItemFigureCount({ ...base, rawVariations: [], rawImport: receipt([{ formatted_name: "Number of Pets", formatted_value: "1" }]) })?.count,
  1,
);
// nothing explicit: never guess
assert.equal(inferItemFigureCount({ ...base, rawVariations: [], rawImport: receipt([{ formatted_name: "Size", formatted_value: "8x10" }]) }), null);
// buyer's words contradict the option: stays unresolved
assert.equal(
  inferItemFigureCount({ ...base, rawVariations: [], rawImport: receipt([{ formatted_name: "Number of Pets", formatted_value: "1" }], "please draw my 3 dogs") }),
  null,
);
// multi-item order: receipt not mapped onto an item
assert.equal(
  inferItemFigureCount({ ...base, itemCount: 2, rawVariations: [], rawImport: receipt([{ formatted_name: "Number of Pets", formatted_value: "1" }]) }),
  null,
);
console.log("figure-auto ok");
