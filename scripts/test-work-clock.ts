/**
 * Work clock (lib/orders/work-clock.ts): a revision is late from its own
 * deadline, never from the order's first day. Pure, no DB. `npm run test:work-clock`.
 */
import { ageLabel, workDueAt } from "../lib/orders/work-clock";

let fails = 0;
const report = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) fails++;
};

const placed = new Date("2026-11-01T00:00:00Z");
const customerDue = new Date("2026-11-03T00:00:00Z"); // 3 day customer SLA
const revisionDue = new Date("2026-11-07T00:00:00Z"); // revision asked 6 Nov, 24 h SLA

report("in design: the designer's (reset) deadline is the clock", workDueAt({ status: "in_design", dueAt: customerDue, assignmentDueAt: revisionDue })?.getTime() === revisionDue.getTime());
report("awaiting QC: same clock", workDueAt({ status: "awaiting_qc", dueAt: customerDue, assignmentDueAt: revisionDue })?.getTime() === revisionDue.getTime());
report("in design, legacy assignment with no deadline: customer date", workDueAt({ status: "in_design", dueAt: customerDue, assignmentDueAt: null })?.getTime() === customerDue.getTime());
report("with the customer: her date, not the designer's", workDueAt({ status: "awaiting_approval", dueAt: customerDue, assignmentDueAt: revisionDue })?.getTime() === customerDue.getTime());
report("waiting on photos, no dates: null", workDueAt({ status: "awaiting_photos", dueAt: null, assignmentDueAt: null }) === null);

const now = Date.parse("2026-11-08T12:00:00Z");
report("age: 2d old", ageLabel("2026-11-06T06:00:00Z", now) === "2d old", ageLabel("2026-11-06T06:00:00Z", now));
report("age: 5h old", ageLabel("2026-11-08T07:00:00Z", now) === "5h old");
report("age: just now", ageLabel("2026-11-08T11:40:00Z", now) === "just now");
void placed;

if (fails) { console.error(`${fails} failing`); process.exit(1); }
console.log("work clock: all pass");
