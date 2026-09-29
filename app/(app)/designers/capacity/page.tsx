import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { businesses } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { loadCapacityModel } from "@/lib/agent/capacity";
import { previewRebalance } from "@/lib/agent/rebalance";
import { loadShellData } from "@/lib/shell/context";
import { Badge, DataPanel, Page, PageHeader } from "@/components/ui";
import { CapacityTable } from "@/components/designers/capacity-table";

export const dynamic = "force-dynamic";

export default async function CapacityPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  // Admin only: capacity limits decide who gets work.
  if (user.role !== "admin") redirect(user.role === "designer" ? "/board" : "/designers");

  const { selected } = await loadShellData(user);
  const [model, agentOn, preview] = await Promise.all([
    withUserContext(user, (tx) => loadCapacityModel(tx, selected.id)),
    withUserContext(user, async (tx) => {
      const [b] = await tx
        .select({ on: businesses.agentAssignEnabled })
        .from(businesses)
        .where(eq(businesses.id, selected.id))
        .limit(1);
      return !!b?.on;
    }),
    previewRebalance(selected.id),
  ]);

  return (
    <Page>
      <PageHeader
        title="Capacity"
        description={`How full each designer is at ${selected.name}. Change a limit and the agent plans around it; an admin limit always wins.`}
        actions={
          <Link
            href="/designers"
            className="inline-flex min-h-11 items-center text-sm font-medium text-pigment hover:underline lg:min-h-9"
          >
            Back to designers
          </Link>
        }
      />
      <DataPanel className="flex flex-wrap items-center gap-2 p-3 text-sm text-slate">
        <Badge variant={agentOn ? "success" : "neutral"} dot>
          {agentOn ? "Agent rebalancing on" : "Agent rebalancing off"}
        </Badge>
        <span>
          {agentOn
            ? "The agent moves not-yet-started orders off an over-capacity or away designer every 15 minutes."
            : "Switch on agent assignment in Settings to let the agent move orders. Suggestions below are what it would do."}
        </span>
      </DataPanel>
      <CapacityTable designers={model.designers} suggestions={preview.moves} pinned={preview.skippedPinned} noTarget={preview.noTarget} />
    </Page>
  );
}
