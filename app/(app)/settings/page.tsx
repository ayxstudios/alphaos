import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { shops, businesses, emailTemplates } from "@/lib/db/schema";
import { getShopCredentials, getBusinessGmailCredentials } from "@/lib/db/credentials";
import { loadShellData, ALL_BUSINESSES } from "@/lib/shell/context";
import { Card, EmptyState } from "@/components/ui";
import { Settings as SettingsIcon } from "@/components/ui/icons";
import { EtsyShopCard, type EtsyShopVM } from "@/components/settings/etsy-shop-card";
import { ShopifyShopCard, type ShopifyShopVM } from "@/components/settings/shopify-shop-card";
import { GmailBusinessCard, type GmailBusinessVM } from "@/components/settings/gmail-business-card";
import { TemplateEditor, type TemplateVM } from "@/components/settings/template-editor";
import { DEFAULT_TEMPLATES, TEMPLATE_META, type TemplateKey } from "@/lib/email/templates";
import { appUrl } from "@/lib/urls";
import type { EtsyCredentials, EtsyIntegrationConfig } from "@/lib/integrations/etsy";
import type { ShopifyCredentials, ShopifyIntegrationConfig } from "@/lib/integrations/shopify";
import type { GmailCredentials } from "@/lib/integrations/gmail";

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

  const shopifyShops = await withUserContext(user, (tx) => {
    const cols = {
      id: shops.id,
      name: shops.name,
      integrationConfig: shops.integrationConfig,
    };
    return selected.id === ALL_BUSINESSES
      ? tx.select(cols).from(shops).where(eq(shops.platform, "shopify"))
      : tx
          .select(cols)
          .from(shops)
          .where(and(eq(shops.platform, "shopify"), eq(shops.businessId, selected.id)));
  });

  const shopifyCards: ShopifyShopVM[] = await Promise.all(
    shopifyShops.map(async (s) => {
      const creds = (await withUserContext(user, (tx) =>
        getShopCredentials(tx, s.id),
      )) as ShopifyCredentials;
      const cfg = (s.integrationConfig ?? {}) as ShopifyIntegrationConfig;
      return {
        id: s.id,
        name: s.name,
        hasToken: !!creds.accessToken,
        status: creds.status === "connected" ? "connected" : "not_connected",
        shopDomain: creds.shopDomain ?? null,
        lastSyncCursor: cfg.syncCursor ?? null,
        allowHeuristic: !!cfg.allowHeuristicFigureCount,
        ruleCount: cfg.figureRules?.length ?? 0,
      };
    }),
  );

  // --- Customer email (Gmail + templates), per business -------------------
  // Only meaningful for a single selected business (each has its own OAuth
  // client + mailbox), so we skip it under the cross-business "All" view.
  let gmailVM: GmailBusinessVM | null = null;
  let templateVMs: TemplateVM[] = [];
  if (selected.id !== ALL_BUSINESSES) {
    const creds = (await withUserContext(user, (tx) =>
      getBusinessGmailCredentials(tx, selected.id),
    )) as GmailCredentials | null;
    const [biz] = await withUserContext(user, (tx) =>
      tx.select({ address: businesses.gmailAddress }).from(businesses).where(eq(businesses.id, selected.id)),
    );
    gmailVM = {
      businessId: selected.id,
      name: selected.name,
      hasClient: !!creds?.clientId,
      hasSecret: !!creds?.clientSecret,
      status: creds?.status ?? "not_connected",
      address: creds?.address ?? biz?.address ?? null,
      redirectUri: appUrl("/api/gmail/callback"),
    };

    const overrides = await withUserContext(user, (tx) =>
      tx
        .select({ key: emailTemplates.key, subject: emailTemplates.subject, body: emailTemplates.body })
        .from(emailTemplates)
        .where(eq(emailTemplates.businessId, selected.id)),
    );
    const overrideMap = new Map(overrides.map((o) => [o.key, o]));
    templateVMs = (Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]).map((key) => {
      const o = overrideMap.get(key);
      const meta = TEMPLATE_META[key];
      return {
        key,
        label: meta.label,
        description: meta.description,
        variables: meta.variables,
        subject: o?.subject ?? DEFAULT_TEMPLATES[key].subject,
        body: o?.body ?? DEFAULT_TEMPLATES[key].body,
        customized: !!o,
      };
    });
  }

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

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Shopify shops</h2>
          <p className="text-sm text-slate">
            Connect each Shopify store with its domain and a custom app Admin API token.
          </p>
        </div>
        {shopifyCards.length === 0 ? (
          <Card>
            <EmptyState
              icon={SettingsIcon}
              headline="No Shopify shops"
              body="No Shopify shops in the selected business."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {shopifyCards.map((c) => (
              <ShopifyShopCard key={c.id} shop={c} />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-display text-lg font-semibold text-ink">Customer email (Gmail)</h2>
          <p className="text-sm text-slate">
            Connect each business&apos;s own Google Workspace mailbox and edit the templates
            customers receive.
          </p>
        </div>
        {gmailVM ? (
          <>
            <GmailBusinessCard gmail={gmailVM} />
            <div>
              <h3 className="font-display text-base font-semibold text-ink">Email templates</h3>
              <p className="text-sm text-slate">
                Edit without a deploy. Variables render server-side; a customized template
                overrides the built-in default.
              </p>
            </div>
            <TemplateEditor businessId={gmailVM.businessId} templates={templateVMs} />
          </>
        ) : (
          <Card>
            <EmptyState
              icon={SettingsIcon}
              headline="Pick a business"
              body="Select a single business (top bar) to configure its mailbox and email templates."
            />
          </Card>
        )}
      </section>
    </div>
  );
}
