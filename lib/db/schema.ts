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
]);
export const productType = pgEnum("product_type", ["digital", "physical"]);
export const assetType = pgEnum("asset_type", [
  "reference",
  "submission",
  "final",
]);
export const assetStorage = pgEnum("asset_storage", ["cdn", "r2"]);
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
export const printProvider = pgEnum("print_provider", ["lumaprints", "gelato"]);
export const printMethod = pgEnum("print_method", ["api", "manual"]);
export const earningsStatus = pgEnum("earnings_status", [
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
  email: text("email").notNull(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  // AlphaOS additions:
  role: userRole("role").notNull().default("designer"),
  active: boolean("active").notNull().default(true),
  phone: text("phone"),
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
  gmailTenantDomain: text("gmail_tenant_domain"),
  workspaceSubject: text("workspace_subject"),
  createdAt: createdAt(),
});

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
    status: orderStatus("status").notNull().default("awaiting_photos"),
    source: orderSource("source").notNull(),
    // Customer-facing SLA deadline. Set at import and does NOT move on
    // reassignment (contrast assignments.due_at).
    dueAt: timestamp("due_at", { withTimezone: true }),
    placedAt: timestamp("placed_at", { withTimezone: true }),
    uploadToken: text("upload_token").unique(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("orders_shop_platform_uq").on(t.shopId, t.platformOrderId),
    index("orders_board_idx").on(t.businessId, t.status, t.dueAt),
    index("orders_customer_idx").on(t.customerId),
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
    variation: text("variation"),
    figureCount: integer("figure_count").notNull().default(1),
    style: text("style"),
    productType: productType("product_type").notNull(),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

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
  (t) => [index("qc_checks_order_idx").on(t.orderId)],
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
    token: text("token").notNull().unique(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    decision: proofDecision("decision"),
    revisionNotes: text("revision_notes"),
    createdAt: createdAt(),
  },
  (t) => [index("proofs_order_idx").on(t.orderId)],
);

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
    gmailThreadId: text("gmail_thread_id"),
    gmailMessageId: text("gmail_message_id"),
    body: text("body"),
    toneScore: numeric("tone_score", { precision: 5, scale: 2 }),
    approvedBy: text("approved_by").references(() => users.id, {
      onDelete: "set null",
    }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_order_idx").on(t.orderId),
    index("messages_gmail_thread_idx").on(t.gmailThreadId),
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
    trackingNumber: text("tracking_number"),
    status: text("status"),
    createdAt: createdAt(),
  },
  (t) => [index("print_jobs_order_idx").on(t.orderId)],
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
    rate: numeric("rate", { precision: 10, scale: 2 }).notNull(),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    period: text("period").notNull(),
    status: earningsStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("earnings_designer_period_idx").on(t.designerId, t.period)],
);

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
  (t) => [index("activity_log_order_idx").on(t.orderId, t.createdAt)],
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
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "cascade",
    }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
  ],
);
