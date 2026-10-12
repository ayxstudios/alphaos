// Urgent orders (lib/orders/urgent.ts): who may mark them, the 24 h deadline
// rule (an existing deadline never moves), urgent-first sorting, reason cleanup.
import { canManageUrgent, cleanUrgentReason, urgentDueAt, urgentFirst, URGENT_REASON_MAX } from "../lib/orders/urgent";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };

check("admin may mark", canManageUrgent("admin"));
check("va may mark", canManageUrgent("va"));
for (const role of ["designer", "helper", "", null, undefined]) check(`${String(role)} may not mark`, !canManageUrgent(role));

const now = new Date("2026-10-13T00:00:00Z");
const kept = new Date("2026-10-20T13:59:59Z");
check("existing deadline kept", urgentDueAt(kept, now).getTime() === kept.getTime());
check("no deadline = now + 24 h", urgentDueAt(null, now).toISOString() === "2026-10-14T00:00:00.000Z", urgentDueAt(null, now).toISOString());

const rows = [{ n: 1, u: false }, { n: 2, u: true }, { n: 3, u: false }, { n: 4, u: true }];
check("urgent first, stable", urgentFirst(rows, (r) => r.u).map((r) => r.n).join(",") === "2,4,1,3");
check("input untouched", rows.map((r) => r.n).join(",") === "1,2,3,4");

check("reason trimmed", cleanUrgentReason("  buyer   chasing\n twice ") === "buyer chasing twice");
check("blank reason = null", cleanUrgentReason("   ") === null && cleanUrgentReason(null) === null);
check("reason capped", cleanUrgentReason("x".repeat(500))!.length === URGENT_REASON_MAX);

console.log(failed ? `test-urgent FAILED (${failed})` : "test-urgent OK");
process.exit(failed ? 1 : 0);
