/**
 * Backfills 8 weeks of realistic operating history on top of the mock
 * fixture (scripts/seed.ts) and whatever the mock pipeline / real sync has
 * imported since: completed order lifecycles, QC, proofs, customer
 * messages, print jobs, a real designer-pay ledger, notifications and daily
 * health reports.
 *
 * Connects as the OWNER (DIRECT_URL), same as scripts/seed.ts, and writes
 * rows directly rather than driving lib/orders/transitions.ts (that helper
 * always stamps `new Date()` and has no way to backdate a transition, so a
 * faithful backfill has to insert the same row shapes itself).
 *
 * Idempotent: every row this script creates uses a deterministic id
 * (prefixed "hist-"), and every insert is `.onConflictDoNothing()`. Re-running
 * is a no-op except where it advances a REUSED order's live status forward
 * for the first time (guarded by rawImport.historySeeded).
 *
 * Usage: npm run seed:history
 */
import "./load-env";

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";

import * as schema from "../lib/db/schema";
import { DEFAULT_CHECKLIST } from "../lib/qc/checklist";

neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DIRECT_URL! });
const db = drizzle(pool, { schema });

const DAY_MS = 86_400_000;
const NOW = new Date();
type OrderStatus = (typeof schema.orderStatus.enumValues)[number];

/* ------------------------------------------------------------------------ */
/* Deterministic RNG so re-runs (before the idempotency check trims them)   */
/* produce the same plan.                                                   */
/* ------------------------------------------------------------------------ */
function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260901);
type Rng = () => number;
function rand(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}
function pick<T>(rng: Rng, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/** FNV-1a 32-bit, so a stable string key (an order id) always seeds the same
 * per-order RNG, regardless of how many OTHER orders were built this run. */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function rngFor(key: string): Rng {
  return mulberry32(hashSeed(key));
}

/** A past timestamp, weighted so Mon-Thu gets more volume than Fri, and
 * weekends the least (a real portrait shop's order rhythm). */
function weightedPastTimestamp(rng: Rng, minDaysAgo: number, maxDaysAgo: number): Date {
  const weight = (dow: number) => (dow >= 1 && dow <= 4 ? 1.4 : dow === 5 ? 1.0 : dow === 6 ? 0.5 : 0.4);
  for (let tries = 0; tries < 30; tries++) {
    const daysAgo = rand(rng, minDaysAgo, maxDaysAgo);
    const d = new Date(NOW.getTime() - daysAgo * DAY_MS);
    if (rng() < weight(d.getUTCDay()) / 1.4) {
      d.setUTCHours(Math.floor(rand(rng, 8, 20)), Math.floor(rand(rng, 0, 60)), 0, 0);
      return d;
    }
  }
  const d = new Date(NOW.getTime() - rand(rng, minDaysAgo, maxDaysAgo) * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}
function nextMonday(after: Date): Date {
  const d = new Date(after.getTime());
  d.setUTCHours(23, 0, 0, 0);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 1);
  return d;
}
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}
function melbourneDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/* ------------------------------------------------------------------------ */
/* Reference pools                                                          */
/* ------------------------------------------------------------------------ */
type StyleName = "cartoon" | "watercolor" | "renaissance" | "line-art";
const STYLE_PRODUCTS: Record<StyleName, { title: string; sku: string }> = {
  cartoon: { title: "Custom Hand-Drawn Cartoon Pet Portrait", sku: "PET-CARTOON" },
  watercolor: { title: "Custom Watercolor Pet Portrait from Photo", sku: "PET-WATER" },
  renaissance: { title: "Custom Renaissance Portrait from Photo", sku: "REN-ILLUS" },
  "line-art": { title: "Custom Line Art Portrait, Personalised Gift", sku: "LINE-ILLUS" },
};
const STYLE_NAMES: StyleName[] = ["cartoon", "watercolor", "renaissance", "line-art"];
const QC_FAIL_REASONS = [
  "Face proportions off",
  "Wrong background colour",
  "Pet fur colour doesn't match the reference",
  "Missing tattoo detail",
  "Eye colour incorrect",
  "Hands drawn with an extra finger",
];
const REVISION_NOTES = [
  "Could you fix the eye colour and add our dog's collar please?",
  "The background is too dark, can you brighten it?",
  "One of the tattoos is missing, can you add it back in?",
  "Can you make the fur colour a bit more accurate to the photo?",
];
const APPROVE_REPLIES = ["Looks great, thank you!", "This is perfect, thank you so much!", "Love it, exactly what we wanted!"];
const QUESTION_REPLIES = [
  "Hi, quick question, can you make the background a bit lighter before we approve?",
  "This looks lovely, is it too late to add our other dog as well?",
  "Can we get a version without the hat, just to compare?",
];

/* ------------------------------------------------------------------------ */
/* Row accumulators                                                         */
/* ------------------------------------------------------------------------ */
const newOrders: (typeof schema.orders.$inferInsert)[] = [];
const newOrderItems: (typeof schema.orderItems.$inferInsert)[] = [];
const newAssignments: (typeof schema.assignments.$inferInsert)[] = [];
const newActivity: (typeof schema.activityLog.$inferInsert & { id: string })[] = [];
const newQc: (typeof schema.qcChecks.$inferInsert & { id: string })[] = [];
const newProofs: (typeof schema.proofs.$inferInsert & { id: string })[] = [];
const newMessages: (typeof schema.messages.$inferInsert & { id: string })[] = [];
const newPrintJobs: (typeof schema.printJobs.$inferInsert & { id: string })[] = [];
const newEarnings: (typeof schema.earnings.$inferInsert & { id: string })[] = [];
const newNotifications: (typeof schema.notifications.$inferInsert & { id: string })[] = [];
const newHealthReports: (typeof schema.dailyHealthReports.$inferInsert & { id: string })[] = [];
const orderStatusUpdates: { id: string; status: OrderStatus; updatedAt: Date; revisionBump: number }[] = [];

/* ------------------------------------------------------------------------ */
/* Order lifecycle builder                                                  */
/* ------------------------------------------------------------------------ */
type FinalStage = "complete" | "shipped" | "printing" | "approved" | "awaiting_approval";
type PrintFlag = "normal" | "rejected" | "missing";

type BuildInput = {
  orderId: string;
  businessId: string;
  label: string;
  productType: "digital" | "physical";
  finalStage: FinalStage;
  finalTs: Date;
  figureCount: number;
  designerId: string;
  vaId: string;
  vaId2: string;
  customerEmail: string;
  customerFirst: string;
  rateCents: number;
  qcFail: boolean;
  revision: boolean;
  printFlag: PrintFlag;
  rng: Rng;
};

type BuildResult = {
  placedAt: Date;
  assignedAt: Date;
  dueAt: Date;
  finalStatus: OrderStatus;
  earning: { amount: number; createdAt: Date } | null;
};

function buildLifecycle(input: BuildInput): BuildResult {
  const { orderId, businessId, label, productType, finalStage, figureCount, designerId, vaId, vaId2, customerEmail, customerFirst, rateCents, rng } = input;

  // ---- forward durations (days), only as far as finalStage needs ---------
  const dPhotos = rand(rng, 0, 2);
  const dDesign = rand(rng, 1, 3);
  let dQcFailGap = 0, dRework = 0, dQcRepass = 0;
  if (input.qcFail) {
    dQcFailGap = rand(rng, 0.05, 0.4);
    dRework = rand(rng, 0.5, 1.5);
    dQcRepass = rand(rng, 0.05, 0.3);
  } else {
    dQcRepass = rand(rng, 0.05, 0.4); // same-day QC pass
  }
  const dApproval1 = rand(rng, 0, 3);
  let dReviseDesign = 0, dReviseQc = 0, dApproval2 = 0;
  if (input.revision) {
    dReviseDesign = rand(rng, 1, 2);
    dReviseQc = rand(rng, 0.05, 0.3);
    dApproval2 = rand(rng, 0, 2);
  }
  const dToPrinting = productType === "physical" ? rand(rng, 0, 1) : 0;
  const dPrintingToShipped = productType === "physical" ? rand(rng, 2, 4) : 0;
  const dShippedToDelivered = productType === "physical" ? rand(rng, 3, 7) : 0;
  const dDeliveredToComplete = productType === "physical" ? rand(rng, 0, 1) : rand(rng, 0, 1);

  let total = dPhotos + dDesign + dQcFailGap + dRework + dQcRepass + dApproval1 + dReviseDesign + dReviseQc + dApproval2;
  if (finalStage === "printing" || finalStage === "shipped" || finalStage === "complete") total += dToPrinting;
  if (finalStage === "shipped" || finalStage === "complete") total += dPrintingToShipped;
  if (finalStage === "complete" && productType === "physical") total += dShippedToDelivered + dDeliveredToComplete;
  if (finalStage === "complete" && productType === "digital") total += dDeliveredToComplete; // "processing" buffer

  const placedAt = new Date(input.finalTs.getTime() - total * DAY_MS);
  let t = placedAt;
  let stepSeq = 0;
  const log = (from: OrderStatus | null, to: OrderStatus, actorId: string | null, ts: Date, metadata?: Record<string, unknown>) => {
    stepSeq += 1;
    newActivity.push({ id: `hist-act-${orderId}-${stepSeq}`, businessId, orderId, actorId, action: `order.${to}`, fromState: from, toState: to, createdAt: ts, metadata: { seed: "history", ...metadata } });
  };

  // awaiting_photos -> ready_to_assign
  log("awaiting_photos", "ready_to_assign", vaId, t);
  t = addDays(t, dPhotos);
  // ready_to_assign -> in_design (designer starts)
  log("ready_to_assign", "in_design", designerId, t);
  const assignedAt = t;
  t = addDays(t, dDesign);
  // in_design -> awaiting_qc (submit)
  log("in_design", "awaiting_qc", designerId, t);

  if (input.qcFail) {
    const failTs = addDays(t, dQcFailGap);
    const reason = pick(rng, QC_FAIL_REASONS);
    const items = Object.fromEntries(DEFAULT_CHECKLIST.map((it) => [it.key, true]));
    const failedKey = pick(rng, DEFAULT_CHECKLIST).key;
    items[failedKey] = false;
    newQc.push({
      id: `hist-qc-${orderId}-1`,
      businessId,
      orderId,
      vaId,
      checklistSnapshot: { version: 1, items: DEFAULT_CHECKLIST },
      itemResults: items,
      result: "fail",
      reason,
      createdAt: failTs,
    });
    log("awaiting_qc", "in_design", vaId, failTs, { reason, failedItems: [DEFAULT_CHECKLIST.find((i) => i.key === failedKey)!.label] });
    t = addDays(failTs, dRework);
    log("in_design", "awaiting_qc", designerId, t);
    t = addDays(t, dQcRepass);
  } else {
    t = addDays(t, dQcRepass);
  }
  const items = Object.fromEntries(DEFAULT_CHECKLIST.map((it) => [it.key, true]));
  newQc.push({
    id: `hist-qc-${orderId}-${input.qcFail ? 2 : 1}`,
    businessId,
    orderId,
    vaId,
    checklistSnapshot: { version: 1, items: DEFAULT_CHECKLIST },
    itemResults: items,
    result: "pass",
    reason: null,
    createdAt: t,
  });
  log("awaiting_qc", "awaiting_approval", vaId, t);
  const proofSentAt = t;
  const proofToken = randomUUID();

  const outboundBody = `Hi ${customerFirst}, your proof for order ${label} is ready. Please take a look and let us know if you would like any changes.`;
  newMessages.push({
    id: `hist-msg-${orderId}-1`,
    businessId,
    orderId,
    direction: "outbound",
    channel: "email",
    status: "sent",
    templateKey: "proof_ready",
    address: customerEmail,
    subject: `Your proof is ready - Order ${label}`,
    body: outboundBody,
    sentAt: proofSentAt,
    createdAt: proofSentAt,
    metadata: { seed: "history" },
  });

  if (input.finalStage === "awaiting_approval") {
    // Still waiting: customer asked a question, nobody has replied yet.
    const askTs = input.finalTs;
    newProofs.push({
      id: `hist-proof-${orderId}-1`,
      businessId,
      orderId,
      token: proofToken,
      sentAt: proofSentAt,
      firstViewedAt: askTs,
      viewedAt: askTs,
      decision: null,
      decidedAt: null,
      createdAt: proofSentAt,
    });
    newMessages.push({
      id: `hist-msg-${orderId}-2`,
      businessId,
      orderId,
      direction: "inbound",
      channel: "email",
      status: "received",
      address: customerEmail,
      subject: `Re: Your proof is ready - Order ${label}`,
      body: pick(rng, QUESTION_REPLIES),
      createdAt: askTs,
      metadata: { seed: "history", replyClassification: { intent: "question", confidence: "0.62" } },
    });
    return { placedAt, assignedAt, dueAt: addDays(placedAt, rand(rng, 10, 16)), finalStatus: "awaiting_approval", earning: null };
  }

  t = addDays(proofSentAt, dApproval1);
  let approvedAt = t;
  if (input.revision) {
    const revisionTs = t;
    const notes = pick(rng, REVISION_NOTES);
    newProofs.push({
      id: `hist-proof-${orderId}-1`,
      businessId,
      orderId,
      token: proofToken,
      sentAt: proofSentAt,
      firstViewedAt: revisionTs,
      viewedAt: revisionTs,
      decision: "revision",
      decidedAt: revisionTs,
      failedItems: [pick(rng, DEFAULT_CHECKLIST).label],
      revisionNotes: notes,
      createdAt: proofSentAt,
    });
    newMessages.push({
      id: `hist-msg-${orderId}-2`,
      businessId,
      orderId,
      direction: "inbound",
      channel: "email",
      status: "received",
      address: customerEmail,
      subject: `Re: Your proof is ready - Order ${label}`,
      body: notes,
      createdAt: revisionTs,
      metadata: { seed: "history", replyClassification: { intent: "revision", confidence: "0.87" } },
    });
    log("awaiting_approval", "in_design", vaId2, revisionTs, { reason: notes });
    t = addDays(revisionTs, dReviseDesign);
    log("in_design", "awaiting_qc", designerId, t);
    t = addDays(t, dReviseQc);
    const items2 = Object.fromEntries(DEFAULT_CHECKLIST.map((it) => [it.key, true]));
    newQc.push({ id: `hist-qc-${orderId}-3`, businessId, orderId, vaId, checklistSnapshot: { version: 1, items: DEFAULT_CHECKLIST }, itemResults: items2, result: "pass", reason: null, createdAt: t });
    log("awaiting_qc", "awaiting_approval", vaId, t);
    const proof2SentAt = t;
    newMessages.push({
      id: `hist-msg-${orderId}-3`,
      businessId,
      orderId,
      direction: "outbound",
      channel: "email",
      status: "sent",
      templateKey: "proof_ready",
      address: customerEmail,
      subject: `Your revised proof is ready - Order ${label}`,
      body: `Hi ${customerFirst}, we have made the changes you asked for. Here is the revised proof for order ${label}.`,
      sentAt: proof2SentAt,
      createdAt: proof2SentAt,
      metadata: { seed: "history" },
    });
    t = addDays(proof2SentAt, dApproval2);
    approvedAt = t;
    newMessages.push({
      id: `hist-msg-${orderId}-4`,
      businessId,
      orderId,
      direction: "inbound",
      channel: "email",
      status: "received",
      address: customerEmail,
      subject: `Re: Your revised proof is ready - Order ${label}`,
      body: pick(rng, APPROVE_REPLIES),
      createdAt: approvedAt,
      metadata: { seed: "history", replyClassification: { intent: "approve", confidence: "0.94" } },
    });
    newProofs.push({
      id: `hist-proof-${orderId}-2`,
      businessId,
      orderId,
      token: randomUUID(),
      sentAt: proof2SentAt,
      firstViewedAt: approvedAt,
      viewedAt: approvedAt,
      decision: "approved",
      decidedAt: approvedAt,
      createdAt: proof2SentAt,
    });
  } else {
    newProofs.push({
      id: `hist-proof-${orderId}-1`,
      businessId,
      orderId,
      token: proofToken,
      sentAt: proofSentAt,
      firstViewedAt: approvedAt,
      viewedAt: approvedAt,
      decision: "approved",
      decidedAt: approvedAt,
      createdAt: proofSentAt,
    });
    newMessages.push({
      id: `hist-msg-${orderId}-2`,
      businessId,
      orderId,
      direction: "inbound",
      channel: "email",
      status: "received",
      address: customerEmail,
      subject: `Re: Your proof is ready - Order ${label}`,
      body: pick(rng, APPROVE_REPLIES),
      createdAt: approvedAt,
      metadata: { seed: "history", replyClassification: { intent: "approve", confidence: "0.94" } },
    });
  }
  log("awaiting_approval", "approved", null, approvedAt);

  if (input.finalStage === "approved") {
    return { placedAt, assignedAt, dueAt: addDays(placedAt, rand(rng, 10, 16)), finalStatus: "approved", earning: null };
  }

  if (productType === "digital") {
    t = addDays(approvedAt, dDeliveredToComplete);
    log("approved", "complete", vaId, t);
    const amount = (rateCents * figureCount) / 100;
    newEarnings.push(buildEarning(orderId, businessId, designerId, figureCount, rateCents, [{ orderItemId: `hist-item-${orderId}-1`, style: input.qcFail || input.revision ? "reworked" : "clean", figureCount, rate: money(rateCents), amount: money(rateCents * figureCount) }], t));
    return { placedAt, assignedAt, dueAt: onTimeDueAt(t), finalStatus: "complete", earning: { amount, createdAt: t } };
  }

  // physical: approved -> printing
  t = addDays(approvedAt, dToPrinting);
  log("approved", "printing", vaId, t);
  const printingAt = t;
  const printJob = buildPrintJob(orderId, businessId, printingAt, input.printFlag, rng);
  newPrintJobs.push(printJob.row);

  if (input.finalStage === "printing") {
    return { placedAt, assignedAt, dueAt: addDays(placedAt, rand(rng, 10, 16)), finalStatus: "printing", earning: null };
  }

  t = addDays(printingAt, dPrintingToShipped);
  log("printing", "shipped", vaId, t);
  const shippedAt = t;
  printJob.row.shippedAt = shippedAt;
  if (input.printFlag !== "rejected") {
    printJob.row.trackingNumber = printJob.tracking;
    printJob.row.trackingCompany = "Australia Post";
    printJob.row.trackingUrl = `https://auspost.com.au/mypost/track/#/details/${printJob.tracking}`;
    printJob.row.status = "shipped";
    printJob.row.reconcileState = input.printFlag === "missing" ? "missing" : "shipped";
    if (input.printFlag === "missing") printJob.row.missingFlaggedAt = addDays(shippedAt, rand(rng, 1, 3));
  }

  if (input.finalStage === "shipped") {
    return { placedAt, assignedAt, dueAt: onTimeDueAt(shippedAt), finalStatus: "shipped", earning: null };
  }

  t = addDays(shippedAt, dShippedToDelivered);
  log("shipped", "delivered", vaId, t);
  const deliveredAt = t;
  t = addDays(deliveredAt, dDeliveredToComplete);
  log("delivered", "complete", vaId, t);
  newEarnings.push(buildEarning(orderId, businessId, designerId, figureCount, rateCents, [{ orderItemId: `hist-item-${orderId}-1`, style: input.qcFail || input.revision ? "reworked" : "clean", figureCount, rate: money(rateCents), amount: money(rateCents * figureCount) }], t));
  return { placedAt, assignedAt, dueAt: onTimeDueAt(shippedAt), finalStatus: "complete", earning: { amount: (rateCents * figureCount) / 100, createdAt: t } };

  function onTimeDueAt(anchor: Date): Date {
    return chance(rng, 0.88) ? addDays(anchor, rand(rng, 0, 3)) : addDays(anchor, -rand(rng, 1, 4));
  }
}

function buildEarning(
  orderId: string,
  businessId: string,
  designerId: string,
  figureCount: number,
  rateCents: number,
  breakdown: schema.EarningBreakdown[],
  createdAt: Date,
): typeof schema.earnings.$inferInsert & { id: string } {
  return {
    id: `hist-earn-${orderId}`,
    businessId,
    designerId,
    orderId,
    figureCount,
    rate: money(rateCents),
    amount: money(rateCents * figureCount),
    breakdown,
    period: createdAt.toISOString().slice(0, 7),
    status: "pending",
    createdAt,
  };
}

function buildPrintJob(orderId: string, businessId: string, submittedAt: Date, flag: PrintFlag, rng: Rng) {
  // Deterministic per order (never a run-order-dependent counter), so a
  // re-run always regenerates the same provider/tracking for the same order.
  const seedNum = hashSeed(orderId) % 900_000;
  const provider = hashSeed(orderId) % 2 === 0 ? "gelato" : "lumaprints";
  const tracking = `36${String(100_000_000 + seedNum).padStart(9, "0")}AU`;
  const providerOrderId = provider === "gelato" ? `GEL-${100_000 + seedNum}` : `LUMA-${100_000 + seedNum}`;
  const row: typeof schema.printJobs.$inferInsert & { id: string } = {
    id: `hist-print-${orderId}`,
    businessId,
    orderId,
    provider,
    method: "api",
    externalId: providerOrderId,
    providerOrderId,
    providerOrderNumber: providerOrderId,
    providerPayload: { seed: "history" },
    status: flag === "rejected" ? "rejected" : "accepted",
    submittedAt,
    acceptedAt: flag === "rejected" ? null : addDays(submittedAt, rand(rng, 0.1, 1)),
    rejectedAt: flag === "rejected" ? addDays(submittedAt, rand(rng, 0.1, 0.6)) : null,
    error: flag === "rejected" ? "Provider rejected: artwork resolution too low for the selected print size." : null,
    reconcileState: flag === "rejected" ? "problem" : "pending",
    createdAt: submittedAt,
  };
  return { row, tracking };
}

/* ------------------------------------------------------------------------ */
/* Main                                                                      */
/* ------------------------------------------------------------------------ */
async function main() {
  const url = new URL(process.env.DIRECT_URL!);
  if (url.username !== "neondb_owner") {
    throw new Error(`seed-history must run as the owner (DIRECT_URL); got user "${url.username}"`);
  }

  const businesses = await db.select({ id: schema.businesses.id, slug: schema.businesses.slug }).from(schema.businesses).orderBy(schema.businesses.id);
  const shops = await db.select({ id: schema.shops.id, businessId: schema.shops.businessId, platform: schema.shops.platform, name: schema.shops.name }).from(schema.shops).orderBy(schema.shops.id);
  const users = await db.select({ id: schema.users.id, email: schema.users.email, role: schema.users.role }).from(schema.users).orderBy(schema.users.id);
  const styles = await db.select({ businessId: schema.styles.businessId, name: schema.styles.name, perFigureRate: schema.styles.perFigureRate }).from(schema.styles).orderBy(schema.styles.id);
  const designerBiz = await db.select({ userId: schema.designerBusinesses.userId, businessId: schema.designerBusinesses.businessId }).from(schema.designerBusinesses).orderBy(schema.designerBusinesses.userId, schema.designerBusinesses.businessId);
  const designerProfiles = await db.select({ userId: schema.designerProfiles.userId, perFigureRate: schema.designerProfiles.perFigureRate }).from(schema.designerProfiles).orderBy(schema.designerProfiles.userId);
  const customers = await db.select({ id: schema.customers.id, businessId: schema.customers.businessId, email: schema.customers.email, firstName: schema.customers.firstName }).from(schema.customers).orderBy(schema.customers.id);

  const byEmail = new Map(users.map((u) => [u.email, u]));
  const vaIds = users.filter((u) => u.role === "va").map((u) => u.id);
  const admin = users.find((u) => u.role === "admin")!;

  // Ensure every seeded designer profile has a real per-figure rate (only
  // touches rows that are actually null; the base fixture already sets one).
  await db
    .update(schema.designerProfiles)
    .set({ perFigureRate: sql`(case when ${schema.designerProfiles.userId} = ${byEmail.get("d1@aystudios.io")?.id} then '18.00' when ${schema.designerProfiles.userId} = ${byEmail.get("d2@aystudios.io")?.id} then '16.50' else '20.00' end)::numeric` })
    .where(and(inArray(schema.designerProfiles.userId, [byEmail.get("d1@aystudios.io")!.id, byEmail.get("d2@aystudios.io")!.id, byEmail.get("d3@aystudios.io")!.id]), sql`${schema.designerProfiles.perFigureRate} is null`));
  void designerProfiles;

  const rateByBusinessStyle = new Map<string, number>();
  for (const s of styles) {
    if (!s.perFigureRate) continue;
    rateByBusinessStyle.set(`${s.businessId}:${s.name}`, Math.round(Number(s.perFigureRate) * 100));
  }
  const designersByBusiness = new Map<string, string[]>();
  for (const row of designerBiz) {
    const list = designersByBusiness.get(row.businessId) ?? [];
    list.push(row.userId);
    designersByBusiness.set(row.businessId, list);
  }
  const customersByBusiness = new Map<string, { id: string; email: string; firstName: string }[]>();
  for (const c of customers) {
    const list = customersByBusiness.get(c.businessId) ?? [];
    list.push({ id: c.id, email: c.email, firstName: c.firstName ?? "there" });
    customersByBusiness.set(c.businessId, list);
  }

  /* ---- 1. fix + advance the REUSED orders ------------------------------ */
  const reusable = await db
    .select({ id: schema.orders.id, businessId: schema.orders.businessId, status: schema.orders.status, placedAt: schema.orders.placedAt, source: schema.orders.source, platformOrderId: schema.orders.platformOrderId, platformOrderName: schema.orders.platformOrderName, customerId: schema.orders.customerId, rawImport: schema.orders.rawImport })
    .from(schema.orders)
    .where(inArray(schema.orders.status, ["printing", "shipped", "delivered", "approved", "awaiting_approval", "complete"]))
    .orderBy(schema.orders.id);

  const reusedTargets: { keepStatus: FinalStage; row: (typeof reusable)[number] }[] = [];
  for (const row of reusable) {
    if ((row.rawImport as { historySeeded?: boolean } | null)?.historySeeded) continue;
    if (row.status === "printing" && !reusedTargets.some((r) => r.keepStatus === "printing")) {
      reusedTargets.push({ keepStatus: "printing", row });
    } else if (row.status === "awaiting_approval" && !reusedTargets.some((r) => r.keepStatus === "awaiting_approval")) {
      reusedTargets.push({ keepStatus: "awaiting_approval", row });
    } else {
      reusedTargets.push({ keepStatus: "complete", row });
    }
  }

  for (const { keepStatus, row } of reusedTargets) {
    // Dedicated per-row RNG, seeded from the order's own (stable) id: its plan
    // never drifts because of how many OTHER reused rows happened to qualify
    // this run.
    const rng = rngFor(row.id);
    const items = await db.select({ id: schema.orderItems.id, figureCount: schema.orderItems.figureCount, style: schema.orderItems.style }).from(schema.orderItems).where(eq(schema.orderItems.orderId, row.id));
    const item = items[0];
    if (!item) continue;
    const style = pick(rng, STYLE_NAMES);
    await db.update(schema.orderItems).set({ style }).where(eq(schema.orderItems.id, item.id));
    const figureCount = item.figureCount ?? Math.ceil(rand(rng, 1, 4));
    const productType = row.source === "shopify" ? "physical" : "digital";
    const designerPool = designersByBusiness.get(row.businessId) ?? [];
    const designerId = pick(rng, designerPool);
    const custPool = customersByBusiness.get(row.businessId) ?? [];
    const customer = custPool.find((c) => c.id === row.customerId) ?? pick(rng, custPool);
    const rateCents = rateByBusinessStyle.get(`${row.businessId}:${style}`) ?? 400;
    const label = row.platformOrderName ?? row.platformOrderId;
    const finalStage: FinalStage = keepStatus === "complete" ? "complete" : keepStatus;
    const finalTs = finalStage === "awaiting_approval" ? weightedPastTimestamp(rng, 0, 2) : finalStage === "printing" ? weightedPastTimestamp(rng, 1, 8) : weightedPastTimestamp(rng, 15, 45);
    const result = buildLifecycle({
      orderId: row.id,
      businessId: row.businessId,
      label,
      productType,
      finalStage,
      finalTs,
      figureCount,
      designerId,
      vaId: pick(rng, vaIds),
      vaId2: pick(rng, vaIds),
      customerEmail: customer.email,
      customerFirst: customer.firstName,
      rateCents,
      qcFail: chance(rng, 0.15),
      revision: finalStage === "awaiting_approval" ? false : chance(rng, 0.15),
      printFlag: "normal",
      rng,
    });
    orderStatusUpdates.push({ id: row.id, status: result.finalStatus, updatedAt: finalTs, revisionBump: 0 });
    await db.update(schema.orders).set({ dueAt: result.dueAt, rawImport: { historySeeded: true } }).where(eq(schema.orders.id, row.id));
    if (!row.customerId) await db.update(schema.orders).set({ customerId: customer.id }).where(eq(schema.orders.id, row.id));
    // assignment (may already exist; keep it, only insert if missing)
    const [existingAssignment] = await db.select({ id: schema.assignments.id }).from(schema.assignments).where(and(eq(schema.assignments.orderId, row.id), eq(schema.assignments.active, true)));
    if (!existingAssignment) {
      newAssignments.push({ id: `hist-asn-${row.id}`, businessId: row.businessId, orderId: row.id, designerId, assignedBy: pick(rng, vaIds), assignedAt: result.assignedAt, dueAt: result.dueAt, active: true });
    }
  }

  /* ---- 2. new synthetic orders ----------------------------------------- */
  const physicalFinal: FinalStage[] = [...Array(72).fill("complete"), ...Array(7).fill("shipped"), ...Array(5).fill("printing"), ...Array(4).fill("approved")] as FinalStage[];
  const digitalFinal: FinalStage[] = [...Array(77).fill("complete"), ...Array(5).fill("approved"), ...Array(6).fill("awaiting_approval")] as FinalStage[];
  const physicalShuffled = shuffle(rnd, physicalFinal);
  const digitalShuffled = shuffle(rnd, digitalFinal);

  // Carve the print-flag special cases out of the physical "printing"/"shipped" buckets.
  let printingSeen = 0;
  let shippedSeen = 0;
  const printFlags: PrintFlag[] = physicalShuffled.map((stage) => {
    if (stage === "printing") {
      printingSeen += 1;
      return printingSeen <= 3 ? "rejected" : "normal";
    }
    if (stage === "shipped") {
      shippedSeen += 1;
      return shippedSeen <= 2 ? "missing" : "normal";
    }
    return "normal";
  });

  const shopifyShops = shops.filter((s) => s.platform === "shopify");
  const etsyShops = shops.filter((s) => s.platform === "etsy");
  const repeatCustomers = new Map<string, { id: string; email: string; firstName: string }[]>();
  for (const biz of businesses) {
    const pool = customersByBusiness.get(biz.id) ?? [];
    repeatCustomers.set(biz.id, shuffle(rnd, pool).slice(0, 6));
  }

  let seq = 0;
  function nextOrder(shop: { id: string; businessId: string; platform: "etsy" | "shopify"; name: string }, stage: FinalStage, printFlag: PrintFlag) {
    seq += 1;
    const orderId = `hist-order-${shop.id.slice(0, 6)}-${seq}`;
    // Dedicated per-order RNG, seeded from the (stable) order id: this
    // order's whole plan is fixed forever the moment it is first built,
    // independent of anything else this run touches.
    const rng = rngFor(orderId);
    const productType: "digital" | "physical" = shop.platform === "shopify" ? "physical" : "digital";
    const style = pick(rng, STYLE_NAMES);
    const figureCount = chance(rng, 0.5) ? 1 : chance(rng, 0.75) ? 2 : 3;
    const designerPool = designersByBusiness.get(shop.businessId) ?? [];
    const designerId = pick(rng, designerPool);
    const isRepeat = chance(rng, 0.25);
    const custPool = isRepeat ? repeatCustomers.get(shop.businessId)! : customersByBusiness.get(shop.businessId)!;
    const customer = pick(rng, custPool);
    const rateCents = rateByBusinessStyle.get(`${shop.businessId}:${style}`) ?? 400;
    const recent = stage === "awaiting_approval" || stage === "printing" || stage === "approved";
    const finalTs = stage === "awaiting_approval" ? weightedPastTimestamp(rng, 0, 3) : recent ? weightedPastTimestamp(rng, 0, 10) : weightedPastTimestamp(rng, 1, 56);
    const orderNo = 4000 + seq;
    const prefix = shop.name.toLowerCase().startsWith("lumina") ? "LM" : "PC";
    const label = shop.platform === "shopify" ? `${prefix}${orderNo}` : `HIST-${orderNo}`;

    const va1 = pick(rng, vaIds);
    const va2 = pick(rng, vaIds);
    const result = buildLifecycle({
      orderId,
      businessId: shop.businessId,
      label,
      productType,
      finalStage: stage,
      finalTs,
      figureCount,
      designerId,
      vaId: va1,
      vaId2: va2,
      customerEmail: customer.email,
      customerFirst: customer.firstName,
      rateCents,
      qcFail: chance(rng, 0.15),
      revision: stage === "awaiting_approval" ? false : chance(rng, 0.15),
      printFlag,
      rng,
    });

    newOrders.push({
      id: orderId,
      businessId: shop.businessId,
      shopId: shop.id,
      customerId: customer.id,
      platformOrderId: `HIST-${shop.id.slice(0, 4)}-${seq}`,
      platformOrderName: shop.platform === "shopify" ? label : null,
      status: result.finalStatus,
      source: shop.platform,
      dueAt: result.dueAt,
      placedAt: result.placedAt,
      uploadToken: randomUUID(),
      revisionCount: 0,
      rawImport: { historySeeded: true },
      createdAt: result.placedAt,
      updatedAt: finalTs,
    });
    newOrderItems.push({
      id: `hist-item-${orderId}-1`,
      businessId: shop.businessId,
      orderId,
      sku: `${STYLE_PRODUCTS[style].sku}-${figureCount}F`,
      title: STYLE_PRODUCTS[style].title,
      variation: `${figureCount} ${figureCount === 1 ? "Figure" : "Figures"}`,
      figureCount,
      figureCountSource: "shop_rule",
      style,
      productType,
    });
    newAssignments.push({ id: `hist-asn-${orderId}`, businessId: shop.businessId, orderId, designerId, assignedBy: va1, assignedAt: result.assignedAt, dueAt: result.dueAt, active: true });
    return { orderId, businessId: shop.businessId, finalStatus: result.finalStatus, earning: result.earning };
  }

  const builtNew: { orderId: string; businessId: string; finalStatus: string; earning: { amount: number; createdAt: Date } | null }[] = [];
  physicalShuffled.forEach((stage, i) => {
    const shop = shopifyShops[i % shopifyShops.length];
    builtNew.push(nextOrder(shop, stage, printFlags[i]));
  });
  digitalShuffled.forEach((stage, i) => {
    const shop = etsyShops[i % etsyShops.length];
    builtNew.push(nextOrder(shop, stage, "normal"));
  });

  /* ---- 3. earnings ledger status pass ----------------------------------- */
  const completedEarnings = newEarnings.slice(); // already only created for completed orders
  const twoWeeksAgo = addDays(NOW, -14);
  let blockedApplied = 0;
  let voidApplied = 0;
  for (const e of completedEarnings) {
    const createdAt = e.createdAt as Date;
    if (blockedApplied < 2) {
      e.status = "blocked";
      e.blockedReason = "Figure count disputed - VA is confirming the real count with the customer.";
      e.amount = null;
      e.rate = null;
      blockedApplied += 1;
      continue;
    }
    if (voidApplied < 1) {
      e.status = "voided";
      e.voidedAt = addDays(createdAt, 1);
      e.voidedBy = admin.id;
      e.voidReason = "Duplicate earning - order was credited to the wrong designer and re-issued.";
      voidApplied += 1;
      continue;
    }
    if (createdAt < twoWeeksAgo) {
      e.status = "paid";
      e.paidAt = nextMonday(createdAt);
      e.paidBy = admin.id;
    } else {
      e.status = "pending";
    }
  }

  /* ---- 4. notifications --------------------------------------------------- */
  const orderLabel = new Map<string, string>();
  for (const o of newOrders) orderLabel.set(o.id as string, (o.platformOrderName as string | null) ?? (o.platformOrderId as string));
  let notifSeq = 0;
  function notify(userId: string, businessId: string, title: string, body: string, href: string, createdAt: Date) {
    notifSeq += 1;
    newNotifications.push({ id: `hist-notif-${userId}-${notifSeq}`, businessId, userId, type: "history.seed", title, body, href, createdAt, readAt: null });
  }
  const rejectedOrders = builtNew.filter((_, i) => i < physicalShuffled.length && printFlags[i] === "rejected");
  const missingOrders = builtNew.filter((_, i) => i < physicalShuffled.length && printFlags[i] === "missing");
  for (const o of rejectedOrders.slice(0, 3)) {
    notify(admin.id, o.businessId, `Print job rejected on ${orderLabel.get(o.orderId) ?? o.orderId}`, "The print provider rejected the artwork. Check the resolution and resend.", `/orders/${o.orderId}`, addDays(NOW, -rand(rnd, 0, 3)));
  }
  for (const o of missingOrders.slice(0, 2)) {
    notify(admin.id, o.businessId, `Print job missing for ${orderLabel.get(o.orderId) ?? o.orderId}`, "Reconciliation could not find this order at the provider.", `/orders/${o.orderId}`, addDays(NOW, -rand(rnd, 0, 2)));
  }
  const blockedForNotif = completedEarnings.filter((e) => e.status === "blocked").slice(0, 2);
  for (const e of blockedForNotif) {
    notify(admin.id, e.businessId as string, `Earning blocked on ${orderLabel.get(e.orderId as string) ?? e.orderId}`, "Figure count disputed, needs a rate before it can be paid.", "/payouts", addDays(NOW, -rand(rnd, 0, 4)));
  }
  const unansweredNew = builtNew.filter((b) => b.finalStatus === "awaiting_approval");
  for (const va of vaIds) {
    for (const o of unansweredNew.slice(0, 3)) {
      notify(va, o.businessId, `Customer waiting on a reply - ${orderLabel.get(o.orderId) ?? o.orderId}`, "The customer replied to the proof and is still waiting to hear back.", `/orders/${o.orderId}`, addDays(NOW, -rand(rnd, 0, 2)));
    }
  }
  for (const biz of businesses) {
    for (const designerId of designersByBusiness.get(biz.id) ?? []) {
      const mine = builtNew.filter((o) => o.businessId === biz.id).slice(0, 2);
      for (const o of mine) {
        notify(designerId, biz.id, `QC feedback on ${orderLabel.get(o.orderId) ?? o.orderId}`, "A note from QC is waiting on your board.", `/orders/${o.orderId}`, addDays(NOW, -rand(rnd, 0, 3)));
      }
    }
  }

  /* ---- 5. daily health reports -------------------------------------------- */
  for (const biz of businesses) {
    for (let i = 0; i < 14; i++) {
      const d = addDays(NOW, -i);
      const key = melbourneDateKey(d);
      const shipped = Math.round(rand(rnd, 2, 9));
      const overdue = Math.round(rand(rnd, 0, 4));
      newHealthReports.push({
        id: `hist-health-${biz.slug}-${key}`,
        scope: "business",
        scopeId: biz.id,
        businessId: biz.id,
        reportDate: key,
        metricsHash: `hist-${biz.slug}-${key}`,
        narrative: `${shipped} orders shipped, ${overdue} overdue. Designer boards are moving at a normal pace and the print queue is clear.`,
        status: "ok",
        generatedAt: d,
        createdAt: d,
        updatedAt: d,
      });
    }
  }

  /* ---- 6. write everything ------------------------------------------------ */
  console.log(`Inserting ${newOrders.length} orders, ${newOrderItems.length} items, ${newAssignments.length} assignments...`);
  if (newOrders.length) await db.insert(schema.orders).values(newOrders).onConflictDoNothing();
  if (newOrderItems.length) await db.insert(schema.orderItems).values(newOrderItems).onConflictDoNothing();
  if (newAssignments.length) await db.insert(schema.assignments).values(newAssignments).onConflictDoNothing();

  console.log(`Inserting ${newActivity.length} activity_log rows...`);
  for (let i = 0; i < newActivity.length; i += 500) {
    await db.insert(schema.activityLog).values(newActivity.slice(i, i + 500)).onConflictDoNothing();
  }
  console.log(`Inserting ${newQc.length} qc_checks, ${newProofs.length} proofs, ${newMessages.length} messages...`);
  if (newQc.length) await db.insert(schema.qcChecks).values(newQc).onConflictDoNothing();
  if (newProofs.length) await db.insert(schema.proofs).values(newProofs).onConflictDoNothing();
  for (let i = 0; i < newMessages.length; i += 500) {
    await db.insert(schema.messages).values(newMessages.slice(i, i + 500)).onConflictDoNothing();
  }
  console.log(`Inserting ${newPrintJobs.length} print_jobs, ${completedEarnings.length} earnings...`);
  if (newPrintJobs.length) await db.insert(schema.printJobs).values(newPrintJobs).onConflictDoNothing();
  if (completedEarnings.length) await db.insert(schema.earnings).values(completedEarnings).onConflictDoNothing();

  console.log(`Inserting ${newNotifications.length} notifications, ${newHealthReports.length} daily health reports...`);
  if (newNotifications.length) await db.insert(schema.notifications).values(newNotifications).onConflictDoNothing();
  if (newHealthReports.length) await db.insert(schema.dailyHealthReports).values(newHealthReports).onConflictDoNothing();

  console.log(`Advancing ${orderStatusUpdates.length} reused orders...`);
  for (const u of orderStatusUpdates) {
    await db.update(schema.orders).set({ status: u.status, updatedAt: u.updatedAt }).where(eq(schema.orders.id, u.id));
  }

  const counts = await db.execute<{ t: string; n: number }>(sql`
    select 'orders' t, count(*)::int n from orders where raw_import->>'historySeeded' = 'true'
    union all select 'activity_log', count(*)::int from activity_log where metadata->>'seed' = 'history'
    union all select 'qc_checks', count(*)::int from qc_checks where id like 'hist-qc-%'
    union all select 'proofs', count(*)::int from proofs where id like 'hist-proof-%'
    union all select 'messages', count(*)::int from messages where id like 'hist-msg-%'
    union all select 'print_jobs', count(*)::int from print_jobs where id like 'hist-print-%'
    union all select 'earnings', count(*)::int from earnings where id like 'hist-earn-%'
    union all select 'notifications', count(*)::int from notifications where id like 'hist-notif-%'
    union all select 'daily_health_reports', count(*)::int from daily_health_reports where id like 'hist-health-%'
    order by t
  `);
  console.log("\nseed-history complete:");
  for (const row of counts.rows) console.log(`  ${row.t}: ${row.n}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error("seed-history failed:", err);
  await pool.end();
  process.exit(1);
});
