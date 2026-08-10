import { redirect } from "next/navigation";
import Link from "next/link";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { withUserContext } from "@/lib/db";
import { businesses, emailTemplates, shops } from "@/lib/db/schema";
import {
  getBusinessGmailCredentials,
  getShopCredentials,
} from "@/lib/db/credentials";
import { loadShellData, isAllBusinesses } from "@/lib/shell/context";
import { PickBusinessPrompt } from "@/components/shell/pick-business-prompt";
import { Badge, DataPanel, EmptyState, Page, PageHeader, SectionHeader } from "@/components/ui";
import {
  Building,
  Brush,
  Mail,
  Package,
  Settings as SettingsIcon,
  type IconProps,
} from "@/components/ui/icons";
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
import { ShopStylesPanel, type ShopStylesVM } from "@/components/settings/shop-styles-panel";
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
  freshShopifyCredentials,
  getShopifyOrdersCreateWebhookStatus,
  shopifyOrdersCreateWebhookUrl,
  type ShopifyCredentials,
  type ShopifyIntegrationConfig,
} from "@/lib/integrations/shopify";
import type { GmailCredentials } from "@/lib/integrations/gmail";

export const dynamic = "force-dynamic";

const SETTINGS_SECTIONS = [
  { key: "etsy", label: "Etsy", icon: Building },
  { key: "shopify", label: "Shopify", icon: Package },
  { key: "portrait-styles", label: "Portrait Styles", icon: Brush },
  { key: "email", label: "Customer Email", icon: Mail },
] as const satisfies readonly { key: string; label: string; icon: (p: IconProps) => React.ReactElement }[];

type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["key"];

function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.key === value);
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const sp = await searchParams;
  const activeSection: SettingsSection = isSettingsSection(sp.section)
    ? sp.section
    : "etsy";

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
  if (isAllBusinesses(selected.id)) return <PickBusinessPrompt title="Settings" />;

  const etsyShops = await withUserContext(user, (tx) => {
    const cols = {
      id: shops.id,
      name: shops.name,
      integrationConfig: shops.integrationConfig,
    };
    return tx
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
        lastSyncAt: cfg.lastSyncAt ?? null,
        allowHeuristic: !!cfg.allowHeuristicFigureCount,
        ruleCount: cfg.figureRules?.length ?? 0,
        figureRules: cfg.figureRules ?? [],
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
    return tx
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
      const connected = isShopifyConnected(creds);
      const liveCreds = connected ? await freshShopifyCredentials(creds) : creds;
      const webhookStatus = connected
        ? await getShopifyOrdersCreateWebhookStatus(s.id, liveCreds).catch((e) => ({
            expectedUrl: shopifyOrdersCreateWebhookUrl(),
            registered: false,
            pointingCorrectly: false,
            subscriptions: [],
            error: e instanceof Error ? e.message : String(e),
          }))
        : {
            expectedUrl: shopifyOrdersCreateWebhookUrl(),
            registered: false,
            pointingCorrectly: false,
            subscriptions: [],
          };
      return {
        id: s.id,
        name: s.name,
        authType: resolveShopifyAuthType(creds),
        status: connected ? "connected" : "not_connected",
        shopDomain: creds.shopDomain ?? null,
        hasClientId: !!creds.clientId,
        hasClientSecret: !!creds.clientSecret,
        hasToken: !!creds.accessToken,
        hasWebhookSecret: !!creds.webhookSecret,
        lastSyncCursor: cfg.syncCursor ?? null,
        lastSyncAt: cfg.lastSyncAt ?? null,
        webhookStatus,
        allowHeuristic: !!cfg.allowHeuristicFigureCount,
        ruleCount: cfg.figureRules?.length ?? 0,
        figureRules: cfg.figureRules ?? [],
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
  // Each business has its own OAuth client and mailbox.
  let gmailVM: GmailBusinessVM | null = null;
  let templateVMs: TemplateVM[] = [];
  const creds = (await withUserContext(user, (tx) =>
    getBusinessGmailCredentials(tx, selected.id),
  )) as GmailCredentials | null;
  const [biz] = await withUserContext(user, (tx) =>
    tx
      .select({ address: businesses.gmailAddress, sendingEnabled: businesses.emailSendingEnabled })
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
    sendingEnabled: !!biz?.sendingEnabled,
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

  // Portrait styles each shop offers — the catalog designer styles are drawn from.
  const styleShops: ShopStylesVM[] = (
    await withUserContext(user, (tx) => {
      const cols = {
        id: shops.id,
        name: shops.name,
        platform: shops.platform,
        styles: shops.styles,
      };
      return tx.select(cols).from(shops).where(eq(shops.businessId, selected.id)).orderBy(shops.name);
    })
  ).map((s) => ({ id: s.id, name: s.name, platform: s.platform, styles: s.styles ?? [] }));

  const sectionCounts: Record<SettingsSection, number> = {
    etsy: cards.length,
    shopify: shopifyCards.length,
    "portrait-styles": styleShops.length,
    email: gmailVM ? 1 : 0,
  };
  const connectedCounts: Record<SettingsSection, number> = {
    etsy: cards.filter((c) => c.status === "connected").length,
    shopify: shopifyCards.filter((c) => c.status === "connected").length,
    "portrait-styles": 0,
    email: gmailVM?.status === "connected" ? 1 : 0,
  };

  return (
    <Page className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside>
        <nav
          aria-label="Settings sections"
          className="sticky top-20 flex gap-1 overflow-x-auto rounded-card border border-line bg-surface p-1.5 text-sm shadow-sm lg:flex-col lg:overflow-visible"
        >
          {SETTINGS_SECTIONS.map((section) => {
            const active = activeSection === section.key;
            const Glyph = section.icon;
            const count = sectionCounts[section.key];
            const connected = connectedCounts[section.key];
            return (
              <Link
                key={section.key}
                href={`/settings?section=${section.key}`}
                aria-current={active ? "page" : undefined}
                className={
                  active
                    ? "flex shrink-0 items-center gap-2.5 rounded-input bg-pigment px-3 py-2.5 font-medium text-surface"
                    : "flex shrink-0 items-center gap-2.5 rounded-input px-3 py-2.5 text-slate transition-colors motion-hover hover:bg-canvas hover:text-ink"
                }
              >
                <Glyph size={16} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                {(section.key === "etsy" || section.key === "shopify") && count > 0 && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-mono tabular-nums",
                      active
                        ? "bg-surface/20 text-surface"
                        : connected === count
                          ? "bg-sage/10 text-sage"
                          : "bg-amber/10 text-amber",
                    )}
                  >
                    {connected}/{count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader
          title="Settings"
          description="Manage shop connections, import rules, Gmail, and customer templates."
          eyebrow="Admin"
        />

        {activeSection === "etsy" && (
          <section className="flex flex-col gap-4">
            <SectionHeader
              title="Etsy shops"
              description="Connect each Etsy shop with its own app credentials, then import orders."
              actions={
                cards.length > 0 && (
                  <Badge variant={connectedCounts.etsy === cards.length ? "success" : "warning"} dot>
                    {connectedCounts.etsy} of {cards.length} connected
                  </Badge>
                )
              }
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
        )}

        {activeSection === "shopify" && (
          <section className="flex flex-col gap-4">
            <SectionHeader
              title="Shopify shops"
              description="Connect each store with its domain and custom app Admin API token."
              actions={
                shopifyCards.length > 0 && (
                  <Badge
                    variant={connectedCounts.shopify === shopifyCards.length ? "success" : "warning"}
                    dot
                  >
                    {connectedCounts.shopify} of {shopifyCards.length} connected
                  </Badge>
                )
              }
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
        )}

        {activeSection === "portrait-styles" && (
          <section className="flex flex-col gap-4">
            <SectionHeader
              title="Portrait Styles catalog"
              description="Per-shop lists of the portrait styles that shop sells. Auto-assign rules and designer eligibility are managed on the dedicated Portrait Styles page."
              actions={
                <Link
                  href="/styles"
                  className="inline-flex h-8 items-center gap-1.5 rounded-input border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors motion-hover hover:bg-canvas"
                >
                  <Brush size={14} />
                  Open Portrait Styles
                </Link>
              }
            />
            {styleShops.length === 0 ? (
              <DataPanel>
                <EmptyState
                  icon={SettingsIcon}
                  headline="No shops"
                  body="No shops in the selected business."
                />
              </DataPanel>
            ) : (
              <DataPanel className="px-4 py-1">
                <ShopStylesPanel shops={styleShops} />
              </DataPanel>
            )}
          </section>
        )}

        {activeSection === "email" && (
          <section className="flex flex-col gap-4">
            <SectionHeader
              title="Customer email"
              description="Connect the business mailbox and edit customer-facing templates."
            />
            {gmailVM ? (
              <>
                <GmailBusinessCard gmail={gmailVM} />
                <div className="mt-2 border-t border-line pt-5">
                  <h3 className="font-display text-lg text-ink">
                    Email templates
                  </h3>
                  <p className="mt-0.5 text-sm text-slate">
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
        )}
      </div>
    </Page>
  );
}
