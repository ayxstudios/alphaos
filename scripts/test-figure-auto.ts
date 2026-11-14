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

// --- subject-led options, tolerant labels, style default, subject-less titles ---
const raw = (name: string, value: string) => [{ name, value }];
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("Options", "House & 3 Figure/pet"), rawImport: null })?.count, 4);
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("Drawing Options", "House (With Yard)"), rawImport: null })?.count, 1);
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("No. of characters (venues, people, pets, etc)", "Venue +2 people/pets"), rawImport: null })?.count, 3);
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("Options", "Car Only"), rawImport: null })?.count, 1);
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("Number Of People/Pets", "2 Figures+Background"), rawImport: null })?.count, 2);
// the buyer counting only the extras agrees with "Venue +2 people/pets"
assert.equal(
  inferItemFigureCount({ ...base, rawVariations: raw("Options", "Venue +2 people/pets"), rawImport: receipt([], "please add my 2 dogs") })?.count,
  3,
);
// unreadable option that looks like a count: never guess a default over it
assert.equal(inferItemFigureCount({ ...base, rawVariations: raw("Options", "House + pets"), title: "Custom House Portrait", rawImport: null }), null);
// style default only with the item's current style, and only when no option talks about a count
const cfg = { styleFigureDefaults: { Cartoon: 1 } } as never;
assert.equal(inferItemFigureCount({ ...base, config: cfg, style: "cartoon", rawVariations: raw("Size", "8x10"), rawImport: null })?.count, 1);
assert.equal(inferItemFigureCount({ ...base, config: cfg, style: null, rawVariations: raw("Size", "8x10"), rawImport: null }), null);
assert.equal(inferItemFigureCount({ ...base, config: cfg, style: "cartoon", rawVariations: raw("Options", "House + pets"), rawImport: null }), null);
// subject-less titles
const t = (title: string, extra: Record<string, unknown> = {}) =>
  inferItemFigureCount({ ...base, rawVariations: [], rawImport: null, title, productType: "digital", ...extra });
assert.equal(t("Minimalist Watercolour Sketch of Your Home")?.count, 1);
assert.equal(t("Custom Watercolor House Portrait")?.count, 1);
assert.equal(t("Personalized Car Drawing from Photo, Custom Watercolor Vehicle Portrait")?.count, 1);
assert.equal(t("Custom House Portrait with Family and Pets"), null);
assert.equal(t("Custom Pet Portrait"), null);
assert.equal(t("Custom House Portrait", { productType: "physical" }), null);
assert.equal(t("Custom House Portrait", { rawImport: { message_from_buyer: "add my 2 dogs" } }), null);
// personalization numbers are NOT a stated figure count
for (const note of ["12 Milliken Ave", "established 2020", "November 21, 2026", "Lot 7, 3 Ocean Road, est 1998"]) {
  assert.equal(t("Custom House Portrait", { rawImport: { message_from_buyer: note } })?.count, 1, note);
}
console.log("figure-auto ok");
