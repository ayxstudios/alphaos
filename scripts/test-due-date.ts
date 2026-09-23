// Due dates typed as a calendar day never drift across saves (smoke r3 follow-up).
import { dateInputValue, parseDueDate } from "../lib/time";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };
for (const day of ["2026-09-14", "2026-01-05", "2026-04-05", "2026-10-04", "2026-12-31"]) {
  const stored = parseDueDate(day);
  check(`round trip ${day}`, dateInputValue(stored) === day, `${stored.toISOString()} -> ${dateInputValue(stored)}`);
  check(`end of day ${day}`, /T(13|12):59:59/.test(stored.toISOString()), stored.toISOString());
}
// An Etsy timestamp that is 14 Sept in Melbourne but 13 Sept in UTC shows as 14.
check("melbourne day of a utc evening", dateInputValue("2026-09-13T15:30:00Z") === "2026-09-14", dateInputValue("2026-09-13T15:30:00Z"));
check("iso passthrough", parseDueDate("2026-09-13T15:30:00.000Z").toISOString() === "2026-09-13T15:30:00.000Z");
check("empty", dateInputValue(null) === "");
console.log(failed ? `test-due-date FAILED (${failed})` : "test-due-date OK");
process.exit(failed ? 1 : 0);
