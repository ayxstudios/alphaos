import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops } from "@/lib/db/schema";
import { getShopCredentials } from "@/lib/db/credentials";
import { loadShellData, ALL_BUSINESSES } from "@/lib/shell/context";
import { Card, EmptyState } from "@/components/ui";
import { Settings as SettingsIcon } from "@/components/ui/icons";
import { EtsyShopCard, type EtsyShopVM } from "@/components/settings/etsy-shop-card";
import type { EtsyCredentials, EtsyIntegrationConfig } from "@/lib/integrations/etsy";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };

  if (user.role !== "admin") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
        <Card>
          <EmptyState
            icon={SettingsIcon}
            headline="Managed by an admin"
            body="Shop connections and integration settings are configured by an admin."
          />
        </Card>
      </div>
    );
  }

  const { selected } = await loadShellData(user);

  const etsyShops = await withUserContext(user, (tx) => {
    const cols = {
      id: shops.id,
      name: shops.name,
      integrationConfig: shops.integrationConfig,
    };
    return selected.id === ALL_BUSINESSES
      ? tx.select(cols).from(shops).where(eq(shops.platform, "etsy"))
      : tx
          .select(cols)
          .from(shops)
          .where(and(eq(shops.platform, "etsy"), eq(shops.businessId, selected.id)));
  });

  const cards: EtsyShopVM[] = await Promise.all(
    etsyShops.map(async (s) => {
      const creds = (await withUserContext(user, (tx) =>
        getShopCredentials(tx, s.id),
      )) as EtsyCredentials;
      const cfg = (s.integrationConfig ?? {}) as EtsyIntegrationConfig;
      return {
        id: s.id,
        name: s.name,
        hasKeystring: !!creds.keystring,
        status: creds.status ?? "not_connected",
        etsyShopId: creds.etsyShopId ?? null,
        lastSyncCursor: cfg.syncCursor ?? null,
        allowHeuristic: !!cfg.allowHeuristicFigureCount,
        ruleCount: cfg.figureRules?.length ?? 0,
      };
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-display text-2xl font-semibold text-ink">Settings</h1>
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Etsy shops</h2>
          <p className="text-sm text-slate">
            Connect each Etsy shop with its own app credentials, then import orders.
          </p>
        </div>
        {cards.length === 0 ? (
          <Card>
            <EmptyState
              icon={SettingsIcon}
              headline="No Etsy shops"
              body="No Etsy shops in the selected business."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {cards.map((c) => (
              <EtsyShopCard key={c.id} shop={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
