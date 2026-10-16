// No-limbo census (docs/NO_LIMBO.md L6), read-only. Per business: live orders
// with a designer, waiting on the buyer, in the pipeline, raised to the owner,
// and limbo (target 0) with the limbo order numbers.
//   npx tsx scripts/limbo-census.ts [--business <name|id>] [--plan [--all]]
// --plan adds what the next agent tick would do, as dry runs: mail cleared (L2),
// rows auto-closed (L1), stuck orders raised (L4) and the owner message (L5).
// Nothing is written either way.
import "./load-env";

import { clearUnmatchedReplies } from "../lib/agent/junk-mail";
import { autoCloseStaleExceptions, getLimboCensus, handFailedAiToDesigners, watchWaitingStates } from "../lib/agent/limbo";
import { sendOwnerDigest } from "../lib/agent/owner-digest";
import { withSystemContext } from "../lib/db";
import { businesses } from "../lib/db/schema";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const plan = process.argv.includes("--plan");
  const only = arg("--business")?.toLowerCase();
  const now = new Date();
  const all = await withSystemContext((tx) =>
    tx.select({ id: businesses.id, name: businesses.name }).from(businesses).orderBy(businesses.name),
  );
  const list = only ? all.filter((b) => b.id === only || b.name.toLowerCase().includes(only)) : all;
  if (!list.length) throw new Error(`no business matches ${only}`);

  let limboTotal = 0;
  const closing: string[] = [];
  for (const b of list) {
    const c = await getLimboCensus(b.id, { now });
    limboTotal += c.limbo;
    console.log(
      `\n${c.businessName}: ${c.live} live | designer ${c.withDesigner} | buyer ${c.waitingOnBuyer} | ` +
        `pipeline ${c.inPipeline} | raised ${c.withOwner} | LIMBO ${c.limbo}`,
    );
    for (const o of c.limboOrders.slice(0, 30)) console.log(`  limbo ${o.number} (${o.status}): ${o.why}`);
    if (c.limboOrders.length > 30) console.log(`  +${c.limboOrders.length - 30} more`);
    if (c.archivedUnfinished) console.log(`  archived but still owed: ${c.archivedUnfinished}`);
    if (!plan) continue;
    const mail = await clearUnmatchedReplies(b.id, { now, dryRun: true });
    const ai = await handFailedAiToDesigners(b.id, { now, dryRun: true });
    const stale = await autoCloseStaleExceptions(b.id, { now, dryRun: true });
    const watch = await watchWaitingStates(b.id, { now, dryRun: true });
    closing.push(...mail.closedIds, ...ai.closedIds, ...stale.ids, ...watch.closedIds);
    console.log(
      `  plan: mail ${mail.checked} (matched ${mail.matched}, junk ${mail.junk}, legacy ${mail.legacy}, already handled ${mail.gone}, kept ${mail.kept}) | ` +
        `AI failed to a person ${ai.handed} (kept ${ai.kept}) | auto-close ${stale.closed} ${JSON.stringify(stale.byReason)} | ` +
        `stuck open ${watch.opened}, refresh ${watch.refreshed}, close ${watch.closed}`,
    );
  }
  console.log(`\nlimbo total: ${limboTotal}`);
  if (plan) {
    const d = await sendOwnerDigest({ now, dryRun: true, businessIds: list.map((b) => b.id), skipIds: closing });
    console.log(`\nowner message (dry run): due ${d.due}, would raise ${d.raised}, held by the hourly limit ${d.skippedRecent}`);
    for (const t of d.texts) console.log(`---\n${t}`);
    if (process.argv.includes("--all") && d.allLines) console.log(`--- every line\n${d.allLines.join("\n")}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
