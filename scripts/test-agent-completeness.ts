// computeCompleteness: pure unit checks, no database.
import { computeCompleteness } from "../lib/agent/completeness";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const item = (figureCount: number | null, figureCountSource: string | null) => ({ figureCount, figureCountSource });

let r = computeCompleteness({ photoCount: 3, items: [item(2, "shop_rule"), item(1, "manual")] });
check("ok when photos equal figures", r.verdict === "ok" && r.expectedFigures === 3 && r.photoCount === 3, JSON.stringify(r));

r = computeCompleteness({ photoCount: 5, items: [item(2, "shop_rule")] });
check("extra photos are ok", r.verdict === "ok" && r.expectedFigures === 2, JSON.stringify(r));

r = computeCompleteness({ photoCount: 1, items: [item(2, "shop_rule")] });
check("fewer photos is a mismatch", r.verdict === "mismatch" && r.expectedFigures === 2, JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [item(1, "manual")] });
check("no photos for one figure is a mismatch", r.verdict === "mismatch", JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [item(2, "shop_rule"), item(null, "unresolved")] });
check("one unresolved item makes it unknown", r.verdict === "unknown" && r.expectedFigures === null, JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [item(null, null)] });
check("null count is unknown", r.verdict === "unknown", JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [item(3, "heuristic")] });
check("heuristic guess is unknown, never a mismatch", r.verdict === "unknown", JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [item(3, "unresolved")] });
check("unresolved source with a count is unknown", r.verdict === "unknown", JSON.stringify(r));

r = computeCompleteness({ photoCount: 4, items: [] });
check("zero items is ok, nothing expected", r.verdict === "ok" && r.expectedFigures === 0, JSON.stringify(r));

r = computeCompleteness({ photoCount: 0, items: [] });
check("zero items zero photos is ok", r.verdict === "ok" && r.expectedFigures === 0, JSON.stringify(r));

console.log(failed ? `test-agent-completeness FAILED (${failed})` : "test-agent-completeness OK");
process.exit(failed ? 1 : 0);
