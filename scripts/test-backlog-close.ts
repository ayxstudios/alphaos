/**
 * Backlog close (lib/orders/backlog-close.ts). Part 1 is pure (liveReasons). Part 2 closes one real quiet pre-cut order
 * inside a transaction, checks status, activity row and exceptions, then rolls everything back.
 * `npx tsx scripts/test-backlog-close.ts`.
 */
import "./load-env";

import { and, desc, eq } from "drizzle-orm";

import { withSystemContext } from "../lib/db";
import { activityLog, exceptions, orders } from "../lib/db/schema";
import {
  BACKLOG_CUT,
  closeBacklogOrder,
  liveReasons,
  loadBacklog,
  type BacklogFacts,
} from "../lib/orders/backlog-close";

let fails = 0;
const report = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) fails++;
};

const now = Date.parse("2026-11-08T08:00:00Z");
const base: BacklogFacts = {
  id: "x",
  businessId: "b",
  business: "CPS",
  number: "1",
  status: "awaiting_approval",
  placedAt: "2026-10-01T00:00:00Z",
  kinds: "digital",
  printJobs: 0,
  heldPrint: false,
  openExceptions: 0,
  firstQcPass: "2026-10-05T00:00:00Z",
  lastBuyerMessage: null,
  lastBuyerAction: null,
  lastDesign: "2026-10-05T00:00:00Z",
  lastPrint: null,
  urgentAt: null,
  urgentBy: null,
  urgentReason: null,
};
report("quiet old proof closes", liveReasons(base, now, 10).length === 0);
report(
  "buyer wrote 3 days ago stays",
  liveReasons({ ...base, lastBuyerMessage: "2026-11-05T00:00:00Z" }, now, 10)
    .length === 1,
);
report(
  "buyer wrote 20 days ago closes",
  liveReasons({ ...base, lastBuyerMessage: "2026-10-19T00:00:00Z" }, now, 10)
    .length === 0,
);
report(
  "designer upload yesterday stays",
  liveReasons({ ...base, lastDesign: "2026-11-07T00:00:00Z" }, now, 10)
    .length === 1,
);
report(
  "held approved print stays",
  liveReasons({ ...base, status: "approved", heldPrint: true }, now, 10)
    .length === 1,
);
report(
  "agent's own deadline urgent closes",
  liveReasons(
    {
      ...base,
      urgentAt: "2026-11-07T00:00:00Z",
      urgentBy: "agent",
      urgentReason: "customer deadline close: x",
    },
    now,
    10,
  ).length === 0,
);
report(
  "a person's urgent stays",
  liveReasons(
    {
      ...base,
      urgentAt: "2026-11-07T00:00:00Z",
      urgentBy: "agent",
      urgentReason: "Customer asked for an update: rush it",
    },
    now,
    10,
  ).length === 1,
);

class Rollback extends Error {}

async function live() {
  const facts = await withSystemContext((tx) => loadBacklog(tx, BACKLOG_CUT));
  const pick =
    facts.find(
      (f) =>
        liveReasons(f, Date.now(), 10).length === 0 &&
        f.status === "awaiting_approval",
    ) ?? facts.find((f) => liveReasons(f, Date.now(), 10).length === 0);
  if (!pick) report("a quiet pre-cut order to try", false, "none found");
  else {
    try {
      await withSystemContext(async (tx) => {
        const done = await closeBacklogOrder(tx, {
          ...pick,
          live: [],
          kept: false,
        });
        report("closes", !!done, pick.number);
        const [o] = await tx
          .select({ status: orders.status })
          .from(orders)
          .where(eq(orders.id, pick.id));
        report("status complete", o?.status === "complete", o?.status);
        const [log] = await tx
          .select({
            metadata: activityLog.metadata,
            from: activityLog.fromState,
          })
          .from(activityLog)
          .where(eq(activityLog.orderId, pick.id))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);
        const meta = (log?.metadata ?? {}) as Record<string, unknown>;
        report(
          "activity row says backlog_close + prior status",
          meta.via === "backlog_close" && log?.from === pick.status,
          `${meta.via} ${log?.from}`,
        );
        const open = await tx
          .select({ id: exceptions.id })
          .from(exceptions)
          .where(
            and(eq(exceptions.orderId, pick.id), eq(exceptions.status, "open")),
          );
        report("no open exceptions left", open.length === 0, `${open.length}`);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    const [after] = await withSystemContext((tx) =>
      tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, pick.id)),
    );
    report(
      "rolled back untouched",
      after?.status === pick.status,
      after?.status,
    );
  }
}

live().then(
  () => {
    console.log(fails ? `${fails} FAILED` : "all passed");
    process.exit(fails ? 1 : 0);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
