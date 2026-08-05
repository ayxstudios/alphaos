import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { businesses, emailTemplates, shops } from "@/lib/db/schema";
import {
  getBusinessGmailCredentials,
  getShopCredentials,
} from "@/lib/db/credentials";
import { loadShellData, ALL_BUSINESSES } from "@/lib/shell/context";
import { DataPanel, EmptyState, Page, PageHeader, SectionHeader } from "@/components/ui";
import { Settings as SettingsIcon } from "@/components/ui/icons";
import {
  EtsyShopCard,
  type EtsyShopVM,
} from "@/components/settings/etsy-shop-card";
import {
  ShopifyShopCard,
  type ShopifyShopVM,
} from "@/components/settings/shopify-shop-card";
import {
  GmailBusinessCard,
  type GmailBusinessVM,
} from "@/components/settings/gmail-business-card";
import { TemplateEditor, type TemplateVM } from "@/components/settings/template-editor";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_META,
  type TemplateKey,
} from "@/lib/email/templates";
import { getShopOptionNames, getShopSkusAndTitles } from "@/lib/orders/resolution";
import { photoRequestEnabled as resolvePhotoRequestEnabled } from "@/lib/integrations/classify";
import { appUrl } from "@/lib/urls";
import type {
  EtsyCredentials,
  EtsyIntegrationConfig,
} from "@/lib/integrations/etsy";
import {
  resolveShopifyAuthType,
  isShopifyConnected,
  type ShopifyCredentials,
  type ShopifyIntegrationConfig,
} from "@/lib/integrations/shopify";
import type { GmailCredentials } from "@/lib/integrations/gmail";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };

  if (user.role !== "admin") {
    return (
      <Page>
        <PageHeader title="Settings" />
        <DataPanel>
          <EmptyState
            icon={SettingsIcon}
            headline="Managed by an admin"
            body="Shop connections and integration settings are configured by an admin."
          />
        </DataPanel>
      </Page>
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
          .where(
            and(eq(shops.platform, "etsy"), eq(shops.businessId, selected.id)),
          );
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
        figureRules: cfg.figureRules ?? [],
        styleRules: cfg.styleRules ?? [],
        optionNames: await getShopOptionNames(user, s.id),
        nonPortraitSkus: cfg.nonPortraitSkus ?? [],
        nonPortraitTitles: cfg.nonPortraitTitles ?? [],
        photoRequestEnabled: resolvePhotoRequestEnabled(cfg),
        ...(await getShopSkusAndTitles(user, s.id).then((r) => ({
          skuSuggestions: r.skus,
          titleSuggestions: r.titles,
        }))),
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
          .where(
            and(eq(shops.platform, "shopify"), eq(shops.businessId, selected.id)),
          );
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
        authType: resolveShopifyAuthType(creds),
        status: isShopifyConnected(creds) ? "connected" : "not_connected",
        shopDomain: creds.shopDomain ?? null,
        hasClientId: !!creds.clientId,
        hasClientSecret: !!creds.clientSecret,
        hasToken: !!creds.accessToken,
        hasWebhookSecret: !!creds.webhookSecret,
        lastSyncCursor: cfg.syncCursor ?? null,
        allowHeuristic: !!cfg.allowHeuristicFigureCount,
        ruleCount: cfg.figureRules?.length ?? 0,
        figureRules: cfg.figureRules ?? [],
        styleRules: cfg.styleRules ?? [],
        optionNames: await getShopOptionNames(user, s.id),
        nonPortraitSkus: cfg.nonPortraitSkus ?? [],
        nonPortraitTitles: cfg.nonPortraitTitles ?? [],
        photoRequestEnabled: resolvePhotoRequestEnabled(cfg),
        ...(await getShopSkusAndTitles(user, s.id).then((r) => ({
          skuSuggestions: r.skus,
          titleSuggestions: r.titles,
        }))),
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
      tx
        .select({ address: businesses.gmailAddress })
        .from(businesses)
        .where(eq(businesses.id, selected.id)),
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
        .select({
          key: emailTemplates.key,
          subject: emailTemplates.subject,
          body: emailTemplates.body,
        })
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
    <Page className="grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <nav className="sticky top-20 flex flex-col gap-1 text-sm">
          <a
            href="#etsy"
            className="rounded-input px-2 py-1.5 text-slate hover:bg-surface hover:text-ink"
          >
            Etsy
          </a>
          <a
            href="#shopify"
            className="rounded-input px-2 py-1.5 text-slate hover:bg-surface hover:text-ink"
          >
            Shopify
          </a>
          <a
            href="#email"
            className="rounded-input px-2 py-1.5 text-slate hover:bg-surface hover:text-ink"
          >
            Email
          </a>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Settings"
          description="Manage shop connections, import rules, Gmail, and customer templates."
        />

        <section id="etsy" className="flex scroll-mt-20 flex-col gap-4">
          <SectionHeader
            title="Etsy shops"
            description="Connect each Etsy shop with its own app credentials, then import orders."
          />
          {cards.length === 0 ? (
            <DataPanel>
              <EmptyState
                icon={SettingsIcon}
                headline="No Etsy shops"
                body="No Etsy shops in the selected business."
              />
            </DataPanel>
          ) : (
            <div className="flex flex-col gap-4">
              {cards.map((c) => (
                <EtsyShopCard key={c.id} shop={c} />
              ))}
            </div>
          )}
        </section>

        <section id="shopify" className="flex scroll-mt-20 flex-col gap-4">
          <SectionHeader
            title="Shopify shops"
            description="Connect each store with its domain and custom app Admin API token."
          />
          {shopifyCards.length === 0 ? (
            <DataPanel>
              <EmptyState
                icon={SettingsIcon}
                headline="No Shopify shops"
                body="No Shopify shops in the selected business."
              />
            </DataPanel>
          ) : (
            <div className="flex flex-col gap-4">
              {shopifyCards.map((c) => (
                <ShopifyShopCard key={c.id} shop={c} />
              ))}
            </div>
          )}
        </section>

        <section id="email" className="flex scroll-mt-20 flex-col gap-4">
          <SectionHeader
            title="Customer email"
            description="Connect the business mailbox and edit customer-facing templates."
          />
          {gmailVM ? (
            <>
              <GmailBusinessCard gmail={gmailVM} />
              <div>
                <h3 className="text-base font-semibold text-ink">
                  Email templates
                </h3>
                <p className="text-sm text-slate">
                  Edit without a deploy. Variables render server-side; a
                  customized template overrides the built-in default.
                </p>
              </div>
              <TemplateEditor
                businessId={gmailVM.businessId}
                templates={templateVMs}
              />
            </>
          ) : (
            <DataPanel>
              <EmptyState
                icon={SettingsIcon}
                headline="Pick a business"
                body="Select a single business (top bar) to configure its mailbox and email templates."
              />
            </DataPanel>
          )}
        </section>
      </div>
    </Page>
  );
}
