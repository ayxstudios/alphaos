// Pure test for the per-style figure-count default (no DB): an unresolved
// count on a fixed-subject style (car, house) fills from the shop config;
// anything a rule already decided, or a style not in the map, is untouched.
import { applyStyleFigureDefault, resolveFigureCount, type FigureConfig } from "../lib/integrations/figures";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const cfg: FigureConfig = {
  figureRules: [{ match: "Number of People", type: "integer" }],
  styleFigureDefaults: { "Car Portrait": 1, "Watercolor House": 1, "Watercolor Venue": 1 },
};

// A car listing has no count option: unresolved -> default 1.
const car = applyStyleFigureDefault(
  resolveFigureCount([{ name: "Vehicle Type", value: "Truck" }], cfg),
  "Car Portrait",
  cfg,
);
check("car unresolved -> default 1", car.count === 1 && car.source === "shop_rule", car.note);

// Case-insensitive style match.
const house = applyStyleFigureDefault(
  { count: null, source: "unresolved", note: "no shop or default rule matched any variation" },
  "watercolor house",
  cfg,
);
check("style match is case-insensitive", house.count === 1);

// A rule-resolved count always stands, even when a default exists.
const resolved = applyStyleFigureDefault(
  resolveFigureCount([{ name: "Number of People:", value: "3" }], cfg),
  "Watercolor House",
  cfg,
);
check("rule-resolved count stands", resolved.count === 3 && resolved.source === "shop_rule");

// A people style with no default stays unresolved (never guess per-figure work).
const people = applyStyleFigureDefault(
  { count: null, source: "unresolved", note: "no rule matched" },
  "Watercolor People",
  cfg,
);
check("people style stays unresolved", people.count === null && people.source === "unresolved");

// No style / no config -> untouched.
check("null style untouched", applyStyleFigureDefault({ count: null, source: "unresolved", note: "x" }, null, cfg).count === null);
check("no config untouched", applyStyleFigureDefault({ count: null, source: "unresolved", note: "x" }, "Car Portrait", {}).count === null);

// Zero / negative / non-integer defaults are refused.
check(
  "bad default refused",
  applyStyleFigureDefault({ count: null, source: "unresolved", note: "x" }, "Bad", { styleFigureDefaults: { Bad: 0 } }).count === null,
);

console.log(failed ? `\ntest-style-figure-default FAILED (${failed})` : "\ntest-style-figure-default OK");
process.exit(failed ? 1 : 0);
