// Pure ranker test for per-style daily quota groups (no DB): the CPS
// house/venue split — Jerome 1/day (priority 1), Reza 3/day (priority 2),
// Slamet unquota'd takes the rest — plus the no-quota regression path, and
// the Disney routing (Yousif 2026-10-16): big orders to Mar, Wahyu 6 a day
// across CPS + PixArt, Febri 1 a shop, then Mar.
import type { StyleDailyLimit } from "../lib/db/schema";
import {
  passesValueGate,
  quotaGroupFor,
  quotaPool,
  quotaUsed,
  rankCandidates,
  type Candidate,
  type QuotaUse,
} from "../lib/orders/assign";
import type { OrderTotal } from "../lib/orders/order-total";

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

// Overflow (Yousif 2026-10-14, Slamet paused, his share to Jerome): Jerome's
// quota group has overflow, Abdul unquota'd rank 2, Jerome rank 3, Slamet at
// capacity 0. Jerome first while under his limit, then Abdul until Abdul is
// full, then Jerome again instead of nobody.
const overflowDay = (jeromeUsed: number, abdulToday: number): Candidate[] => [
  {
    ...base,
    designerId: "jerome",
    rank: 3,
    styles: house,
    styleQuota: { limit: 2, priority: 1, usedToday: jeromeUsed, overflow: true },
  },
  { ...base, designerId: "abdul", rank: 2, dailyCapacity: 20, ordersAssignedToday: abdulToday, styles: house, styleQuota: null },
  { ...base, designerId: "slamet", rank: 4, dailyCapacity: 0, styles: house, styleQuota: null },
];
const ofFirst = rankCandidates(overflowDay(0, 0), order);
check("overflow: under limit -> Jerome first", ofFirst[0]?.designerId === "jerome", ofFirst.map((c) => c.designerId).join(","));
const ofAbdul = rankCandidates(overflowDay(2, 5), order);
check("overflow: Jerome at limit -> Abdul next", ofAbdul[0]?.designerId === "abdul" && ofAbdul[1]?.designerId === "jerome");
const ofBack = rankCandidates(overflowDay(2, 20), order);
check("overflow: Abdul full -> Jerome again", ofBack[0]?.designerId === "jerome" && ofBack.length === 1);
check("capacity 0 is never eligible", !ofBack.some((c) => c.designerId === "slamet"));
const ofCapped = rankCandidates(
  overflowDay(2, 20).map((c) => (c.designerId === "jerome" ? { ...c, ordersAssignedToday: 15 } : c)),
  order,
);
check("overflow still respects daily capacity", ofCapped.length === 0);
// Without the flag the old hard stop holds (Jerome out once at his limit).
const noFlag = rankCandidates(
  overflowDay(2, 20).map((c) => (c.styleQuota ? { ...c, styleQuota: { ...c.styleQuota, overflow: false } } : c)),
  order,
);
check("no overflow flag: limit is still a hard stop", noFlag.length === 0);

// ---------------------------------------------------------------------------
// Pools, value gates and new orders only (Yousif 2026-10-16)
// ---------------------------------------------------------------------------
const PIX = "pixart";
const CPS = "cps";
const disney = ["cartoon", "Disney Pet", "Disneyfy People"];
const wahyuGroup: StyleDailyLimit = {
  businessId: PIX,
  businessIds: [PIX, CPS],
  styles: disney,
  limit: 6,
  priority: 1,
  overflow: false,
  newOrdersOnly: true,
};
const febriGroups: StyleDailyLimit[] = [PIX, CPS].map((businessId) => ({
  businessId,
  styles: disney,
  limit: 1,
  priority: 2,
  overflow: false,
  newOrdersOnly: true,
}));
const marGroup: StyleDailyLimit = {
  businessId: PIX,
  businessIds: [PIX, CPS],
  styles: disney,
  orderTotalOver: 300,
  currency: "AUD",
  limit: 15,
  priority: 0,
  overflow: true,
};
const aud = (amount: number): OrderTotal => ({ amount, currency: "AUD" });

check("pool: businessId plus businessIds, once each", quotaPool(wahyuGroup).join(",") === "pixart,cps");
check("pool: businessId alone", quotaPool(febriGroups[1]).join(",") === "cps");

check("gate: no gate takes any order, even an unknown total", passesValueGate(wahyuGroup, null));
check("gate: unknown total never passes", !passesValueGate(marGroup, null));
check("gate: BOGO AUD 336 passes", passesValueGate(marGroup, aud(336)));
check("gate: exactly 300 is not over 300", !passesValueGate(marGroup, aud(300)));
check("gate: 300.01 passes", passesValueGate(marGroup, aud(300.01)));
check("gate: wrong currency fails", !passesValueGate(marGroup, { amount: 450, currency: "USD" }));
check("gate: unknown currency fails a currency gate", !passesValueGate(marGroup, { amount: 450, currency: null }));
check("gate: currency matched in any case", passesValueGate(marGroup, { amount: 450, currency: "aud" }));

check("group: big PixArt order -> Mar's value group", quotaGroupFor([marGroup], { businessId: PIX, style: "cartoon", total: aud(336) }) === marGroup);
check("group: big CPS order -> Mar's value group (pool)", quotaGroupFor([marGroup], { businessId: CPS, style: "Disney Pet", total: aud(410) }) === marGroup);
check("group: small order -> no Mar group", quotaGroupFor([marGroup], { businessId: PIX, style: "cartoon", total: aud(120) }) === null);
check("group: unknown total -> no Mar group", quotaGroupFor([marGroup], { businessId: PIX, style: "cartoon" }) === null);
check("group: CPS order in Wahyu's shared pool, any case", quotaGroupFor([wahyuGroup], { businessId: CPS, style: "disney pet" }) === wahyuGroup);
check("group: shop outside the pool -> none", quotaGroupFor([wahyuGroup], { businessId: "perfetta", style: "cartoon" }) === null);
check("group: style outside the group -> none", quotaGroupFor([wahyuGroup], { businessId: CPS, style: "Watercolor House" }) === null);
check("group: per-shop groups pick the order's shop", quotaGroupFor(febriGroups, { businessId: CPS, style: "cartoon" }) === febriGroups[1]);
check("group: no style -> none", quotaGroupFor([wahyuGroup], { businessId: PIX, style: null }) === null);

const todayUse = (id: string, businessId: string, style: string, firstForOrder = true, total: OrderTotal | null = aud(150)): QuotaUse => ({
  assignmentId: id,
  businessId,
  style,
  total,
  firstForOrder,
});
const wahyuDay = [
  todayUse("a1", PIX, "cartoon"),
  todayUse("a2", PIX, "cartoon"),
  todayUse("a2", PIX, "cartoon"), // a two-item order joins twice: still one assignment
  todayUse("a3", CPS, "Disney Pet"),
  todayUse("a4", CPS, "Disney Pet", false), // reassigned to him: not a new order
  todayUse("a5", "perfetta", "cartoon"), // outside the pool
  todayUse("a6", PIX, "Watercolor Pets"), // outside the styles
];
check("used: pool + styles + new orders only, distinct assignments", quotaUsed(wahyuGroup, wahyuDay) === 3, String(quotaUsed(wahyuGroup, wahyuDay)));
check("used: without newOrdersOnly a reassignment counts", quotaUsed({ ...wahyuGroup, newOrdersOnly: false }, wahyuDay) === 4);
check(
  "used: a value group counts only orders over its line",
  quotaUsed(marGroup, [todayUse("m1", PIX, "cartoon", true, aud(336)), todayUse("m2", PIX, "cartoon", true, aud(120)), todayUse("m3", CPS, "cartoon", true, null)]) === 1,
);

// A day of Disney orders, built the way loadRankedCandidates builds them:
// each designer's group for the order, and today's uses so far.
type Day = Record<string, { today: number; uses: QuotaUse[] }>;
const roster = [
  { designerId: "wahyu", rank: 1, dailyCapacity: 15, limits: [wahyuGroup] },
  { designerId: "febri", rank: 2, dailyCapacity: 4, limits: febriGroups },
  { designerId: "mar", rank: 2, dailyCapacity: 15, limits: [marGroup] },
];
const freshDay = (): Day => Object.fromEntries(roster.map((r) => [r.designerId, { today: 0, uses: [] }]));
let seq = 0;
const assignNext = (day: Day, order: { businessId: string; style: string; total: OrderTotal | null }, firstForOrder = true) => {
  const ranked = rankCandidates(
    roster.map((r) => {
      const group = quotaGroupFor(r.limits, order);
      return {
        ...base,
        designerId: r.designerId,
        rank: r.rank,
        dailyCapacity: r.dailyCapacity,
        ordersAssignedToday: day[r.designerId].today,
        styles: disney,
        styleQuota: group
          ? { limit: group.limit, priority: group.priority, usedToday: quotaUsed(group, day[r.designerId].uses), overflow: group.overflow === true }
          : null,
      };
    }),
    order,
  );
  const chosen = ranked[0]?.designerId ?? null;
  if (chosen) {
    day[chosen].today++;
    day[chosen].uses.push(todayUse(`o${++seq}`, order.businessId, order.style, firstForOrder, order.total));
  }
  return chosen;
};

const day = freshDay();
const small = (i: number) => ({ businessId: i % 2 ? PIX : CPS, style: i % 3 ? "cartoon" : "Disney Pet", total: aud(149) });
check("day: a BOGO order goes to Mar first", assignNext(day, { businessId: PIX, style: "cartoon", total: aud(336) }) === "mar");
const firstTen = Array.from({ length: 10 }, (_, i) => assignNext(day, small(i + 1)));
check(
  "day: Wahyu 6 across both shops, Febri 1 a shop, then Mar",
  firstTen.join(",") === "wahyu,wahyu,wahyu,wahyu,wahyu,wahyu,febri,febri,mar,mar",
  firstTen.join(","),
);
check("day: Mar's big order never used Wahyu's 6", quotaUsed(wahyuGroup, day.wahyu.uses) === 6);
check("day: a big order late in the day still goes to Mar", assignNext(day, { businessId: CPS, style: "Disney Pet", total: aud(433) }) === "mar");

const rescue = freshDay();
for (let i = 1; i <= 5; i++) assignNext(rescue, small(i));
check("rescue: a reassignment to Wahyu does not use up his 6", assignNext(rescue, small(6), false) === "wahyu" && assignNext(rescue, small(7)) === "wahyu");
check("rescue: his 6 new orders are counted, then Febri", assignNext(rescue, small(9)) === "febri");

const unknown = freshDay();
check("unknown total: treated as a small order (Wahyu, not Mar)", assignNext(unknown, { businessId: PIX, style: "cartoon", total: null }) === "wahyu");

console.log(failed ? `\ntest-style-quota FAILED (${failed})` : "\ntest-style-quota OK");
process.exit(failed ? 1 : 0);
