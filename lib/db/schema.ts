import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Database schema (Drizzle ORM, PostgreSQL / Neon).
 *
 * Structural definitions only. Row-level security policies and the
 * `customer_public` view live in a separate, hand-written SQL migration
 * (see lib/db/migrations/*_rls_policies.sql) because they are not expressible
 * as portable Drizzle metadata and are the security-critical layer we want to
 * read as plain SQL.
 *
 * The auth block below is the standard Auth.js schema so the Drizzle adapter
 * drops in without a migration rewrite. RLS is intentionally NOT enabled on
 * these tables — NextAuth queries them without a request user-context.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", ["admin", "va", "designer"]);
export const platform = pgEnum("platform", ["etsy", "shopify"]);
export const orderSource = pgEnum("order_source", ["etsy", "shopify", "manual"]);
export const orderStatus = pgEnum("order_status", [
  "awaiting_photos",
  "ready_to_assign",
  "in_design",
  "awaiting_qc",
  "awaiting_approval",
  "approved",
  "printing",
  "shipped",
  "delivered",
  "complete",
  "on_hold",
  "cancelled",
  // Non-portrait lifecycles (appended; enum order is not relied upon):
  // triage: a VA must classify (Shopify draft orders — can't be inferred).
  // fulfillment_only: non-portrait add-on; may need fulfilment, never design.
  "triage",
  "fulfillment_only",
  // awaiting_details: imported from Etsy with only the order header; a VA must
  // open it and fill in figure count / style / photos before it enters design.
  "awaiting_details",
]);
export const productType = pgEnum("product_type", ["digital", "physical"]);
export const assetType = pgEnum("asset_type", [
  "reference",
  "submission",
  "final",
]);
export const assetStorage = pgEnum("asset_storage", ["cdn", "r2"]);
// How an order_item's figure_count was determined (drives payout trust).
export const figureCountSource = pgEnum("figure_count_source", [
  "shop_rule", // matched a per-shop rule (high confidence)
  "heuristic", // generic pattern match (opt-in per shop)
  "manual", // set by a human in the review queue
  "unresolved", // could not determine — excluded from payout
]);
export const channelType = pgEnum("channel_type", [
  "inapp",
  "telegram",
  "discord",
  "webpush",
  "email",
]);
export const proofDecision = pgEnum("proof_decision", ["approved", "revision"]);
export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);
// Lifecycle of a message row. Outbound customer email starts as `draft` (the VA
// approval gate) or `queued` (the two auto-send exceptions: photo request +
// reminder), then `sent`/`failed`. Inbound replies land as `received`.
export const messageStatus = pgEnum("message_status", [
  "draft",
  "queued",
  "sent",
  "failed",
  "received",
]);
// Editable, per-business email templates.
export const emailTemplateKey = pgEnum("email_template_key", [
  "photo_request",
  "proof_ready",
  "revision_received",
  "proof_ready_digital_single",
  "proof_ready_digital_multi",
  "proof_ready_physical_single",
  "proof_ready_physical_multi",
]);
export const printProvider = pgEnum("print_provider", ["lumaprints", "gelato"]);
export const printMethod = pgEnum("print_method", ["api", "manual"]);
export const earningsStatus = pgEnum("earnings_status", [
  "blocked",
  "pending",
  "paid",
  "voided",
]);
export const qcResult = pgEnum("qc_result", ["pass", "fail"]);

// ---------------------------------------------------------------------------
// Auth.js tables (no RLS — see file header)
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  // Unique: credentials login keys on email; also prevents duplicate accounts.
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // AlphaOS additions:
  role: userRole("role").notNull().default("designer"),
  active: boolean("active").notNull().default(true),
  phone: text("phone"),
  // bcrypt hash; nullable — not every user has a password set yet.
  passwordHash: text("password_hash"),
});

// Database-backed login throttling (no Redis). Keyed by lowercased email so it
// also covers attempts against non-existent accounts. No RLS — auth support
// table, written before any session/user context exists.
export const loginAttempts = pgTable("login_attempts", {
  email: text("email").primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Generic fixed-window rate-limit counters (no Redis, mirroring login_attempts).
// Keyed by an opaque bucket string, e.g. "proof:<ip>" or "proof-token:<token>".
// No RLS: it holds no tenant data and is written from the public, unauthenticated
// proof portal where no request user-context exists.
export const rateLimits = pgTable("rate_limits", {
  bucket: text("bucket").primaryKey(),
  hits: integer("hits").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
  ],
);

export const sessions = pgTable("session", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_token",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

export const businesses = pgTable("businesses", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Public-facing brand mark, shown on the customer proof portal. Non-secret.
  logoUrl: text("logo_url"),
  gmailTenantDomain: text("gmail_tenant_domain"),
  workspaceSubject: text("workspace_subject"),
  // Per-business Gmail OAuth. Each business has its OWN Google Cloud project and
  // OAuth client, so the client id/secret + refresh token live in this
  // AES-256-GCM envelope (never selected directly — read via
  // getBusinessGmailCredentials). The sending mailbox address and the inbound
  // history cursor are non-secret and kept as plain columns.
  gmailCredentials: jsonb("gmail_credentials"),
  gmailAddress: text("gmail_address"),
  gmailHistoryId: text("gmail_history_id"),
  // Safety rail: no customer email sends until an admin turns this ON per
  // business. The "send test email" path bypasses it (only sends to staff).
  emailSendingEnabled: boolean("email_sending_enabled").notNull().default(false),
  // Last time the inbound reply poller ran for this mailbox (cron health).
  gmailLastPolledAt: timestamp("gmail_last_polled_at", { withTimezone: true }),
  // Morning owner/admin briefing. Off by default; recipients are explicit admin
  // user ids so a newly-created admin is not silently added to every business.
  dailyHealthEmailEnabled: boolean("daily_health_email_enabled").notNull().default(false),
  dailyHealthEmailRecipientIds: text("daily_health_email_recipient_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  createdAt: createdAt(),
});

// Per-business, database-backed email templates so copy can change without a
// deploy. A missing row falls back to the built-in default for that key
// (lib/email/templates.ts). Bodies use {{variable}} placeholders rendered
// server-side. Staff-scoped by RLS.
export const emailTemplates = pgTable(
  "email_templates",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    key: emailTemplateKey("key").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_templates_business_key_uq").on(t.businessId, t.key)],
);

export const shops = pgTable(
  "shops",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    platform: platform("platform").notNull(),
    name: text("name").notNull(),
    externalShopId: text("external_shop_id").notNull(),
    // AES-256-GCM envelope-encrypted blob; shape differs per platform.
    // Never selected directly in app code — read via getShopCredentials().
    credentials: jsonb("credentials").notNull(),
    slaConfig: jsonb("sla_config"),
    // Non-secret, admin-editable integration config (figure rules, sync cursor,
    // sync lock). Kept out of the encrypted blob so it can be edited without
    // decrypting credentials.
    integrationConfig: jsonb("integration_config"),
    // Portrait styles this shop offers (e.g. Disney, Anime). The catalog a
    // designer's styles are chosen from — you can only pick styles some shop
    // actually sells. Admin-edited in settings.
    styles: text("styles").array(),
    checklistVersion: integer("checklist_version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("shops_platform_external_uq").on(t.platform, t.externalShopId),
    index("shops_business_idx").on(t.businessId),
  ],
);

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const designerProfiles = pgTable("designer_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  dailyCapacity: integer("daily_capacity").notNull().default(0),
  perFigureRate: numeric("per_figure_rate", { precision: 10, scale: 2 }),
  styles: text("styles").array(),
  // Manual priority for auto-assign — LOWER wins (rank 0 is picked first). Staff
  // reorder designers on the Designers page; the ranker uses this as the primary
  // ordering among eligible, style-matched candidates.
  rank: integer("rank").notNull().default(1000),
  createdAt: createdAt(),
});

// Which businesses a designer works across. Also the source of truth the RLS
// designer policies subquery for tenant scope. Intentionally left without RLS
// (config/junction data) so the policy subqueries never recurse.
export const designerBusinesses = pgTable(
  "designer_businesses",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.businessId] }),
    index("designer_businesses_business_idx").on(t.businessId),
  ],
);

// Portrait styles offered by a business (Disney, Watercolor, …). Business-level
// — shared across all of a business's shops. Each style carries its auto-assign
// TITLE rules: an imported product whose title contains any of `titleMatches`
// is tagged with this style; `isDefault` is the fallback when nothing matches.
// A designer is eligible for a style when the style's name is in
// designer_profiles.styles (the auto-assign ranker matches on that name).
export const styles = pgTable(
  "styles",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Case-insensitive substrings matched against the product title.
    titleMatches: text("title_matches").array().notNull().default(sql`'{}'::text[]`),
    // Exact product SKUs mapped to this style — the precise "learned" product key.
    skuMatches: text("sku_matches").array().notNull().default(sql`'{}'::text[]`),
    // Pay rate for one figure in this style. Nullable so missing config creates
    // a blocked earning rather than silently paying zero.
    perFigureRate: numeric("per_figure_rate", { precision: 10, scale: 2 }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("styles_business_name_uq").on(t.businessId, sql`lower(${t.name})`),
    index("styles_business_idx").on(t.businessId),
  ],
);

// Products a VA has chosen to leave without a style (keyed by SKU or, when there
// is none, product title). Kept so the "unrecognised products" list stops asking
// — reversible: un-ignoring deletes the row and the product resurfaces.
export const ignoredProducts = pgTable(
  "ignored_products",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    sku: text("sku"),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [index("ignored_products_business_idx").on(t.businessId)],
);

export const notificationChannels = pgTable("notification_channels", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  channel: channelType("channel").notNull(),
  address: text("address"),
  alertTypes: text("alert_types").array(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("customers_business_email_uq").on(t.businessId, t.email)],
);

// Designer-safe projection of customers (id, business_id, first_name only).
// Created and access-controlled in the RLS SQL migration; declared here as an
// existing view so app code can query it with types. Designers read this;
// admin and VAs read the customers table.
export const customerPublic = pgView("customer_public", {
  id: text("id"),
  businessId: text("business_id"),
  firstName: text("first_name"),
}).existing();

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    shopId: text("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "restrict" }),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    platformOrderId: text("platform_order_id").notNull(),
    // Human-facing order number shown to staff and customers (Shopify `name` like
    // "PC31972", Etsy receipt id). platformOrderId stays the internal id used for
    // idempotency + API refetch; the internal id must never appear in the UI.
    platformOrderName: text("platform_order_name"),
    status: orderStatus("status").notNull().default("awaiting_photos"),
    source: orderSource("source").notNull(),
    // Customer-facing SLA deadline. Set at import and does NOT move on
    // reassignment (contrast assignments.due_at).
    dueAt: timestamp("due_at", { withTimezone: true }),
    placedAt: timestamp("placed_at", { withTimezone: true }),
    uploadToken: text("upload_token").unique(),
    // Set when an import needs a human: unresolved figure count or missing email.
    needsReview: boolean("needs_review").notNull().default(false),
    // Free-text notes / special requests (from manual entry), shown on the
    // designer's card so they know what to make.
    notes: text("notes"),
    // Raw platform payload kept for reference — e.g. the full Etsy receipt so a
    // VA can read the personalization / note-to-seller while completing details.
    rawImport: jsonb("raw_import"),
    // Incremented on rework (QC fail / customer revision -> in_design) in the same
    // transaction as the transition. Distinguishes In Design from Revisions on the
    // boards without scanning activity_log. 0 = first pass.
    revisionCount: integer("revision_count").notNull().default(0),
    // Historical platform orders imported before a shop's backfill cutoff. Kept
    // for customer history/search, excluded from active operations and alerts.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveReason: text("archive_reason"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("orders_shop_platform_uq").on(t.shopId, t.platformOrderId),
    index("orders_board_idx").on(t.businessId, t.status, t.dueAt),
    index("orders_live_board_idx")
      .on(t.businessId, t.status, t.dueAt)
      .where(sql`${t.archivedAt} is null`),
    index("orders_customer_idx").on(t.customerId),
  ],
);

export const orderShippingAddresses = pgTable(
  "order_shipping_addresses",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("platform"),
    name: text("name"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    company: text("company"),
    addressLine1: text("address_line_1"),
    addressLine2: text("address_line_2"),
    city: text("city"),
    state: text("state"),
    postalCode: text("postal_code"),
    countryCode: text("country_code"),
    phone: text("phone"),
    email: text("email"),
    raw: jsonb("raw"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("order_shipping_addresses_order_uq").on(t.orderId),
    index("order_shipping_addresses_business_idx").on(t.businessId),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    sku: text("sku"),
    // Product title (e.g. "Custom Hand-Drawn Cartoon Pet Portrait") — what the
    // designer is making. Shown on the designer card.
    title: text("title"),
    variation: text("variation"),
    // The variant's selectedOptions as structured {name,value} pairs (size, print
    // type, style, figure option…). Drives the designer card; distinct from the
    // raw_variations audit blob below.
    options: jsonb("options").$type<ProductOption[]>(),
    // Nullable: null = unresolved. figureCountSource records how it was set;
    // payout only trusts shop_rule | heuristic | manual (never a silent default).
    figureCount: integer("figure_count"),
    figureCountSource: figureCountSource("figure_count_source"),
    // Every variation/property name/value pair, verbatim (selectedOptions +
    // line-item properties). The exact input the resolver ran against, so a
    // re-resolve reproduces resolution and a VA can back-test rules.
    rawVariations: jsonb("raw_variations"),
    style: text("style"),
    // A VA set this style by hand for this one order ("just this order"); import
    // and re-resolve must not recompute it.
    styleLocked: boolean("style_locked").notNull().default(false),
    productType: productType("product_type").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

/** A structured variant option / line-item property pair. */
export type ProductOption = { name: string; value: string };

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const assets = pgTable(
  "assets",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id").references(() => orderItems.id, {
      onDelete: "set null",
    }),
    type: assetType("type").notNull(),
    storage: assetStorage("storage").notNull(),
    url: text("url"),
    r2Key: text("r2_key"),
    uploadedBy: text("uploaded_by").references(() => users.id, {
      onDelete: "set null",
    }),
    // Retention: the R2 object is hard-deleted after 180 days and the row is
    // marked here (kept for the order's audit trail — the bytes are gone, the
    // record persists). Non-null => the asset no longer resolves.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_order_type_idx").on(t.orderId, t.type),
    // Exactly one location, matching the storage discriminator.
    check(
      "assets_storage_location_ck",
      sql`(${t.storage} = 'cdn' and ${t.url} is not null and ${t.r2Key} is null) or (${t.storage} = 'r2' and ${t.r2Key} is not null and ${t.url} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export const assignments = pgTable(
  "assignments",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    designerId: text("designer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedBy: text("assigned_by").references(() => users.id, {
      onDelete: "set null",
    }),
    assignedAt: createdAt(),
    // This designer's deadline for their attempt. A reassignment inserts a new
    // row with a fresh due_at; orders.due_at (the SLA) is untouched.
    dueAt: timestamp("due_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    // At most one live assignee per order; history preserved via inactive rows.
    uniqueIndex("assignments_active_order_uq")
      .on(t.orderId)
      .where(sql`${t.active}`),
    index("assignments_active_designer_idx")
      .on(t.designerId)
      .where(sql`${t.active}`),
    index("assignments_order_idx").on(t.orderId),
  ],
);

export const qcChecks = pgTable(
  "qc_checks",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    vaId: text("va_id").references(() => users.id, { onDelete: "set null" }),
    checklistSnapshot: jsonb("checklist_snapshot"),
    itemResults: jsonb("item_results"),
    result: qcResult("result").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("qc_checks_order_idx").on(t.orderId),
    index("qc_checks_business_created_idx").on(t.businessId, t.createdAt),
  ],
);

export const proofs = pgTable(
  "proofs",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Dedicated single-purpose proof token: a long random value that grants
    // token-authenticated access to exactly this proof (never the upload token,
    // which serves a different flow). Unique + not guessable/enumerable.
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // First and most-recent customer view. first_viewed_at is set once; viewed_at
    // is updated on every view, so a VA can see "opened, last seen 2h ago".
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    decision: proofDecision("decision"),
    // Set the instant a decision is recorded. Its presence makes the proof
    // read-only: a customer cannot approve and then flip to a revision.
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // Structured revision detail: the checked common-issue keys and any
    // annotation pins ({ x, y } in normalised 0..1 image coordinates).
    failedItems: jsonb("failed_items").$type<string[]>(),
    annotations: jsonb("annotations").$type<ProofAnnotation[]>(),
    revisionNotes: text("revision_notes"),
    createdAt: createdAt(),
  },
  (t) => [index("proofs_order_idx").on(t.orderId)],
);

/** A revision pin dropped on the preview, in normalised image coordinates. */
export type ProofAnnotation = { x: number; y: number };

export const messages = pgTable(
  "messages",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "cascade",
    }),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    direction: messageDirection("direction").notNull(),
    channel: channelType("channel").notNull(),
    // Outbound lifecycle / inbound = 'received'. Drafts wait in the VA outbox.
    status: messageStatus("status").notNull().default("draft"),
    // Which template produced an outbound message (null for inbound / ad-hoc).
    templateKey: emailTemplateKey("template_key"),
    // The proof this email is about, when applicable (proof-ready email).
    proofId: text("proof_id").references(() => proofs.id, {
      onDelete: "set null",
    }),
    subject: text("subject"),
    // Recipient for outbound, sender for inbound.
    address: text("address"),
    gmailThreadId: text("gmail_thread_id"),
    gmailMessageId: text("gmail_message_id"),
    // RFC 5322 Message-ID header value, used for In-Reply-To / References.
    // This is distinct from Gmail's API message id stored in gmail_message_id.
    gmailRfcMessageId: text("gmail_rfc_message_id"),
    body: text("body"),
    // Last send error, for a failed outbound message.
    error: text("error"),
    attachmentAssetId: text("attachment_asset_id").references(() => assets.id, {
      onDelete: "set null",
    }),
    attachmentFilename: text("attachment_filename"),
    attachmentContentType: text("attachment_content_type"),
    attachmentSizeBytes: integer("attachment_size_bytes"),
    metadata: jsonb("metadata"),
    // Resolved-and-hidden: a discarded draft, or an unmatched inbound reply a VA
    // archived. Excludes the row from the outbox / unmatched tray. Reason is in
    // activity_log.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    toneScore: numeric("tone_score", { precision: 5, scale: 2 }),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    manualSentAt: timestamp("manual_sent_at", { withTimezone: true }),
    manualSentBy: text("manual_sent_by").references(() => users.id, {
      onDelete: "set null",
    }),
    manualSentReason: text("manual_sent_reason"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_order_idx").on(t.orderId),
    index("messages_gmail_thread_idx").on(t.gmailThreadId),
    // The outbox: pending drafts across the tenant, newest first.
    index("messages_status_idx").on(t.status, t.createdAt),
    index("messages_business_status_created_idx").on(
      t.businessId,
      t.status,
      t.createdAt,
    ),
  ],
);

export const printJobs = pgTable(
  "print_jobs",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: printProvider("provider").notNull(),
    method: printMethod("method").notNull(),
    externalId: text("external_id"),
    providerOrderId: text("provider_order_id"),
    providerOrderNumber: text("provider_order_number"),
    providerPayload: jsonb("provider_payload"),
    providerResponse: jsonb("provider_response"),
    trackingNumber: text("tracking_number"),
    trackingCompany: text("tracking_company"),
    trackingUrl: text("tracking_url"),
    shopifyFulfillmentId: text("shopify_fulfillment_id"),
    shopifySyncedAt: timestamp("shopify_synced_at", { withTimezone: true }),
    platformSyncedAt: timestamp("platform_synced_at", { withTimezone: true }),
    platformSyncError: text("platform_sync_error"),
    status: text("status"),
    error: text("error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("print_jobs_order_idx").on(t.orderId),
    index("print_jobs_business_status_idx").on(t.businessId, t.status, t.createdAt),
    index("print_jobs_provider_order_idx").on(t.provider, t.providerOrderId),
  ],
);

export const printProductMappings = pgTable(
  "print_product_mappings",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    shopId: text("shop_id")
      .notNull()
      .references(() => shops.id, { onDelete: "cascade" }),
    provider: printProvider("provider").notNull(),
    matchType: text("match_type").notNull().default("sku_exact"),
    sourceSku: text("source_sku"),
    titleContains: text("title_contains"),
    variantContains: text("variant_contains"),
    label: text("label"),
    providerProductId: text("provider_product_id").notNull(),
    providerConfig: jsonb("provider_config"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("print_product_mappings_shop_provider_idx").on(t.shopId, t.provider),
    index("print_product_mappings_business_idx").on(t.businessId),
  ],
);

export const earnings = pgTable(
  "earnings",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    // The active assignee at the moment of completion.
    designerId: text("designer_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // UNIQUE — the DB-level guarantee that a revision cannot mint a second
    // payout for the same order. Insert with ON CONFLICT (order_id) DO NOTHING.
    orderId: text("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "restrict" }),
    figureCount: integer("figure_count").notNull(),
    rate: numeric("rate", { precision: 10, scale: 2 }),
    amount: numeric("amount", { precision: 10, scale: 2 }),
    breakdown: jsonb("breakdown").$type<EarningBreakdown[]>(),
    period: text("period").notNull(),
    status: earningsStatus("status").notNull().default("pending"),
    blockedReason: text("blocked_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: text("paid_by").references(() => users.id, {
      onDelete: "set null",
    }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    voidReason: text("void_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("earnings_designer_period_idx").on(t.designerId, t.period),
    index("earnings_business_status_created_idx").on(
      t.businessId,
      t.status,
      t.createdAt,
    ),
  ],
);

export type EarningBreakdown = {
  orderItemId: string;
  style: string | null;
  figureCount: number;
  rate: string | null;
  amount: string | null;
  blockedReason?: string;
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

// Append-only. The RLS migration grants INSERT + SELECT only; with FORCE RLS
// and no UPDATE/DELETE policy, rows are immutable even to the table owner.
export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    actorId: text("actor_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    fromState: orderStatus("from_state"),
    toState: orderStatus("to_state"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_log_order_idx").on(t.orderId, t.createdAt),
    index("activity_log_business_action_created_idx").on(
      t.businessId,
      t.action,
      t.createdAt,
    ),
  ],
);

export const dailyHealthReports = pgTable(
  "daily_health_reports",
  {
    id: id(),
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    businessId: text("business_id").references(() => businesses.id, {
      onDelete: "cascade",
    }),
    reportDate: text("report_date").notNull(),
    metricsHash: text("metrics_hash").notNull(),
    narrative: text("narrative").notNull(),
    status: text("status").notNull().default("ok"),
    error: text("error"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    emailError: text("email_error"),
    emailRecipients: text("email_recipients").array(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("daily_health_reports_scope_date_uq").on(
      t.scope,
      t.scopeId,
      t.reportDate,
    ),
    index("daily_health_reports_lookup_idx").on(
      t.scope,
      t.scopeId,
      t.reportDate,
    ),
  ],
);

export const notificationFires = pgTable(
  "notification_fires",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    alertType: text("alert_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    metadata: jsonb("metadata"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("notification_fires_business_type_idx").on(t.businessId, t.alertType, t.triggeredAt),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    businessId: text("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fireId: text("fire_id").references(() => notificationFires.id, {
      onDelete: "set null",
    }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "cascade",
    }),
    title: text("title"),
    body: text("body"),
    href: text("href"),
    metadata: jsonb("metadata"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
);
