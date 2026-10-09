// Pure ranker test for per-style daily quota groups (no DB): the CPS
// house/venue split — Jerome 1/day (priority 1), Reza 3/day (priority 2),
// Slamet unquota'd takes the rest — plus the no-quota regression path.
import { rankCandidates, type Candidate } from "../lib/orders/assign";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const base: Omit<Candidate, "designerId" | "styles" | "styleQuota"> = {
  rank: 1000,
  dailyCapacity: 15,
  ordersAssignedToday: 0,
  wipCount: 0,
  onTimeRate30d: 1,
  maxActiveOrders: 0,
};

const house = ["Watercolor House", "Watercolor Venue"];
const candidates = (jeromeUsed: number, rezaUsed: number): Candidate[] => [
  {
    ...base,
    designerId: "jerome",
    styles: ["Watercolor Pets", ...house],
    styleQuota: { limit: 1, priority: 1, usedToday: jeromeUsed },
  },
  {
    ...base,
    designerId: "reza",
    styles: house,
    styleQuota: { limit: 3, priority: 2, usedToday: rezaUsed },
  },
  { ...base, designerId: "slamet", styles: house, styleQuota: null },
];

const order = { style: "Watercolor House" };

// Walk a day of house orders through the quotas the way auto-assign would.
const first = rankCandidates(candidates(0, 0), order);
check("house order 1 -> Jerome", first[0]?.designerId === "jerome", first.map((c) => c.designerId).join(","));

const second = rankCandidates(candidates(1, 0), order);
check("house order 2 (Jerome at limit) -> Reza", second[0]?.designerId === "reza");
check("Jerome filtered out at his limit", !second.some((c) => c.designerId === "jerome"));

const fifth = rankCandidates(candidates(1, 3), order);
check("house order 5 (both at limit) -> Slamet", fifth[0]?.designerId === "slamet");
check("only Slamet left", fifth.length === 1);

// Venue counts in the same pool: Jerome who already took a venue today gets no house.
const venueUsed = rankCandidates(candidates(1, 0), { style: "Watercolor Venue" });
check("venue shares the house pool", venueUsed[0]?.designerId === "reza");

// A pet order ignores the house quota entirely (no group covers it -> caller
// passes styleQuota null; Jerome stays first by style match).
const pet = rankCandidates(
  candidates(1, 3).map((c) => ({ ...c, styleQuota: null })),
  { style: "Watercolor Pets" },
);
check("pets unaffected by house quota", pet[0]?.designerId === "jerome" && pet.length === 1);

// Regression: no quotas anywhere -> original ordering (rank, then remaining capacity).
const plain = rankCandidates(
  [
    { ...base, designerId: "a", styles: ["X"], rank: 2, styleQuota: null },
    { ...base, designerId: "b", styles: ["X"], rank: 1, styleQuota: null },
  ],
  { style: "X" },
);
check("no-quota ordering unchanged (rank wins)", plain[0]?.designerId === "b");

console.log(failed ? `\ntest-style-quota FAILED (${failed})` : "\ntest-style-quota OK");
process.exit(failed ? 1 : 0);
