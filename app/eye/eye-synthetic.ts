import type { EyeData, EyeOrder, EyeStageKey } from "@/lib/eye/data";

/** Dev-only synthetic feed (open /eye?synthetic=500). Never used in production builds. */
const KEYS: EyeStageKey[] = ["intake", "drawing", "qc", "buyer", "print", "done"];
const LABELS = ["Intake", "Drawing", "QC", "With buyer", "Print", "Done"];
const SHOPS = ["Custom Story Shop", "PixArt", "Perfetta", "Dream Tees", "Artisan Portraits", "AY Studios"];

export function makeSyntheticData(count: number): EyeData {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const now = Date.now();
  const orders: EyeOrder[] = [];
  for (let i = 0; i < count; i++) {
    const b = Math.floor(Math.pow(rnd(), 1.6) * SHOPS.length);
    const n = Math.min(5, Math.floor(rnd() * 6.4));
    const r = rnd();
    const sentiment = r < 0.04 ? "unhappy" : r < 0.12 ? "attention" : r < 0.4 ? "happy" : "neutral";
    const delayed = n < 4 && rnd() < 0.12;
    orders.push({
      id: `syn-${i}`,
      orderNumber: `PC${32000 + i}`,
      business: SHOPS[b],
      businessId: `biz-${b}`,
      title: "Disney pet portrait",
      styleName: null,
      buyerFirstName: ["Kendall", "Amanda", "Reilly", "Janice", "Marianne"][i % 5],
      status: "in_design",
      aiState: null,
      stage: { n, key: KEYS[n], label: LABELS[n] },
      held: rnd() < 0.04,
      physical: rnd() < 0.3,
      stageSince: new Date(now - rnd() * 3 * 86400000).toISOString(),
      placedAt: new Date(now - rnd() * 6 * 86400000).toISOString(),
      dueAt: new Date(now + (rnd() - 0.3) * 2 * 86400000).toISOString(),
      delayed,
      overdueHours: delayed ? Math.round(rnd() * 60) : 0,
      urgent: rnd() < 0.05,
      designer: ["Wahyu", "Febri", "Mar", "Abdul", null][i % 5],
      revisionCount: Math.floor(rnd() * 3),
      waitingOnBuyer: n === 3 || rnd() < 0.08,
      print: n === 4 ? { provider: "Gelato", status: "in production", tracking: rnd() < 0.5 ? "AB123456789AU" : null } : null,
      lastBuyerMessage: rnd() < 0.6 ? { snippet: "Hi! Just checking in on my order, thank you so much for the lovely work so far.", at: new Date(now - rnd() * 86400000).toISOString() } : null,
      sentiment,
      exceptions: [],
      href: `/orders/syn-${i}`,
    });
  }
  const open = orders.filter((o) => o.stage.n < 5);
  const businesses = SHOPS.map((name, b) => ({ id: `biz-${b}`, name, openCount: open.filter((o) => o.businessId === `biz-${b}`).length }));
  return {
    generatedAt: new Date(now).toISOString(),
    businesses,
    totals: {
      open: open.length,
      delayed: open.filter((o) => o.delayed).length,
      urgent: open.filter((o) => o.urgent).length,
      waitingOnBuyer: open.filter((o) => o.waitingOnBuyer).length,
      unhappy: open.filter((o) => o.sentiment === "unhappy").length,
      printing: open.filter((o) => o.stage.n === 4).length,
      completedToday: orders.filter((o) => o.stage.n === 5).length,
    },
    orders,
    events: orders.slice(0, 12).map((o, i) => ({
      at: new Date(now - i * 420000).toISOString(),
      orderNumber: o.orderNumber,
      business: o.business,
      label: "moved to Awaiting QC",
    })),
  };
}
