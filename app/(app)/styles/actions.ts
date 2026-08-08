"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser, type Tx } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { styles, designerProfiles, designerBusinesses, users, ignoredProducts } from "@/lib/db/schema";
import {
  learnProductStyle,
  logStyleLearning,
  countOrdersForProduct,
  type Product,
} from "@/lib/orders/style-learning";

export type ActionResult = { ok: true } | { ok: false; message: string };

const NOT_PERMITTED: ActionResult = { ok: false, message: "Not permitted" };

async function requireStaff(): Promise<RequestUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin" && user.role !== "va") return null;
  return user;
}

async function currentBusinessId(user: RequestUser): Promise<string> {
  const { selected } = await loadShellData(user);
  return selected.id;
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Designers (with their current style names) in a business. */
async function businessDesigners(tx: Tx, businessId: string) {
  return tx
    .select({ userId: designerProfiles.userId, styles: designerProfiles.styles })
    .from(designerProfiles)
    .innerJoin(users, and(eq(users.id, designerProfiles.userId), eq(users.active, true), eq(users.role, "designer")))
    .innerJoin(
      designerBusinesses,
      and(eq(designerBusinesses.userId, users.id), eq(designerBusinesses.businessId, businessId)),
    )
    .orderBy(asc(users.name));
}

export async function createStyle(nameRaw: string): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const name = nameRaw.trim();
  if (!name) return { ok: false, message: "Enter a style name" };
  const businessId = await currentBusinessId(user);
  try {
    await withUserContext(user, (tx) => tx.insert(styles).values({ businessId, name }));
  } catch {
    return { ok: false, message: `A style called "${name}" already exists` };
  }
  revalidatePath("/styles");
  return { ok: true };
}

export async function renameStyle(id: string, nameRaw: string): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const name = nameRaw.trim();
  if (!name) return { ok: false, message: "Enter a style name" };
  const businessId = await currentBusinessId(user);
  try {
    await withUserContext(user, async (tx) => {
      const [row] = await tx
        .select({ name: styles.name })
        .from(styles)
        .where(and(eq(styles.id, id), eq(styles.businessId, businessId)));
      if (!row || row.name === name) {
        if (row) await tx.update(styles).set({ name }).where(eq(styles.id, id));
        return;
      }
      const oldName = row.name;
      await tx.update(styles).set({ name }).where(eq(styles.id, id));
      // Cascade the rename into every designer that lists the old style name.
      for (const d of await businessDesigners(tx, businessId)) {
        const cur = d.styles ?? [];
        if (cur.some((s) => s.toLowerCase() === oldName.toLowerCase())) {
          const next = dedupe(cur.map((s) => (s.toLowerCase() === oldName.toLowerCase() ? name : s)));
          await tx.update(designerProfiles).set({ styles: next.length ? next : null }).where(eq(designerProfiles.userId, d.userId));
        }
      }
    });
  } catch {
    return { ok: false, message: `A style called "${name}" already exists` };
  }
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}

export async function setStyleTitleMatches(id: string, rawMatches: string[]): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const titleMatches = dedupe(rawMatches);
  const businessId = await currentBusinessId(user);
  await withUserContext(user, (tx) =>
    tx.update(styles).set({ titleMatches }).where(and(eq(styles.id, id), eq(styles.businessId, businessId))),
  );
  revalidatePath("/styles");
  return { ok: true };
}

export async function setStyleDefault(id: string, isDefault: boolean): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  await withUserContext(user, async (tx) => {
    // At most one default per business.
    if (isDefault) {
      await tx.update(styles).set({ isDefault: false }).where(eq(styles.businessId, businessId));
    }
    await tx.update(styles).set({ isDefault }).where(and(eq(styles.id, id), eq(styles.businessId, businessId)));
  });
  revalidatePath("/styles");
  return { ok: true };
}

export async function deleteStyle(id: string): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  await withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({ name: styles.name })
      .from(styles)
      .where(and(eq(styles.id, id), eq(styles.businessId, businessId)));
    if (!row) return;
    await tx.delete(styles).where(eq(styles.id, id));
    // Remove the deleted style name from any designer that had it.
    for (const d of await businessDesigners(tx, businessId)) {
      const cur = d.styles ?? [];
      if (cur.some((s) => s.toLowerCase() === row.name.toLowerCase())) {
        const next = cur.filter((s) => s.toLowerCase() !== row.name.toLowerCase());
        await tx.update(designerProfiles).set({ styles: next.length ? next : null }).where(eq(designerProfiles.userId, d.userId));
      }
    }
  });
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}

/** Set exactly which designers do this style (edits their style-name arrays). */
export async function setStyleDesigners(id: string, designerIds: string[]): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  const chosen = new Set(designerIds);
  await withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({ name: styles.name })
      .from(styles)
      .where(and(eq(styles.id, id), eq(styles.businessId, businessId)));
    if (!row) return;
    const name = row.name;
    for (const d of await businessDesigners(tx, businessId)) {
      const cur = d.styles ?? [];
      const has = cur.some((s) => s.toLowerCase() === name.toLowerCase());
      const want = chosen.has(d.userId);
      if (has === want) continue;
      const next = want
        ? dedupe([...cur, name])
        : cur.filter((s) => s.toLowerCase() !== name.toLowerCase());
      await tx.update(designerProfiles).set({ styles: next.length ? next : null }).where(eq(designerProfiles.userId, d.userId));
    }
  });
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}

/* --- Unrecognised-product learning ------------------------------------- */

/** Teach an existing style from an unrecognised product (adds a rule + backfills). */
export async function assignProductToStyle(styleId: string, product: Product): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  try {
    await withUserContext(user, async (tx) => {
      const res = await learnProductStyle(tx, businessId, styleId, product);
      await logStyleLearning(tx, {
        businessId,
        actorId: user.id,
        action: "style.learned",
        metadata: { source: "styles_page", product, style: res.styleName, ruleKind: res.ruleKind, ruleValue: res.ruleValue, ordersUpdated: res.orders },
      });
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not assign" };
  }
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}

/** Create a new style from an unrecognised product and learn it in one step. */
export async function createStyleFromProduct(nameRaw: string, product: Product): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const name = nameRaw.trim();
  if (!name) return { ok: false, message: "Enter a style name" };
  const businessId = await currentBusinessId(user);
  try {
    await withUserContext(user, async (tx) => {
      const [created] = await tx.insert(styles).values({ businessId, name }).returning({ id: styles.id });
      const res = await learnProductStyle(tx, businessId, created.id, product);
      await logStyleLearning(tx, {
        businessId,
        actorId: user.id,
        action: "style.learned",
        metadata: { source: "styles_page", newStyle: true, product, style: res.styleName, ruleKind: res.ruleKind, ruleValue: res.ruleValue, ordersUpdated: res.orders },
      });
    });
  } catch (e) {
    const msg = e instanceof Error && /unique|duplicate/i.test(e.message) ? `A style called "${name}" already exists` : "Could not create style";
    return { ok: false, message: msg };
  }
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}

/** Stop asking about a product (reversible). */
export async function ignoreProduct(product: Product): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  await withUserContext(user, async (tx) => {
    const affected = await countOrdersForProduct(tx, businessId, product);
    await tx.insert(ignoredProducts).values({ businessId, sku: product.sku ?? null, title: product.title ?? null });
    await logStyleLearning(tx, {
      businessId,
      actorId: user.id,
      action: "style.ignored",
      metadata: { source: "styles_page", product, ordersAffected: affected },
    });
  });
  revalidatePath("/styles");
  return { ok: true };
}

/** Bring an ignored product back into the unrecognised list. */
export async function unignoreProduct(id: string): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  const businessId = await currentBusinessId(user);
  await withUserContext(user, async (tx) => {
    const [row] = await tx
      .select({ sku: ignoredProducts.sku, title: ignoredProducts.title })
      .from(ignoredProducts)
      .where(and(eq(ignoredProducts.id, id), eq(ignoredProducts.businessId, businessId)));
    if (!row) return;
    await tx.delete(ignoredProducts).where(eq(ignoredProducts.id, id));
    await logStyleLearning(tx, {
      businessId,
      actorId: user.id,
      action: "style.unignored",
      metadata: { source: "styles_page", product: { title: row.title, sku: row.sku } },
    });
  });
  revalidatePath("/styles");
  return { ok: true };
}

/**
 * Confirm defaulted products in bulk: teach each to the shop's default style so
 * it's a real (matched) rule and stops being flagged. One click for a batch.
 */
export async function confirmProductsAsDefault(products: Product[]): Promise<ActionResult> {
  const user = await requireStaff();
  if (!user) return NOT_PERMITTED;
  if (!products.length) return { ok: false, message: "Nothing selected" };
  const businessId = await currentBusinessId(user);
  try {
    await withUserContext(user, async (tx) => {
      const [def] = await tx
        .select({ id: styles.id, name: styles.name })
        .from(styles)
        .where(and(eq(styles.businessId, businessId), eq(styles.isDefault, true)));
      if (!def) throw new Error("No default style set for this workspace");
      const learned: Record<string, unknown>[] = [];
      let ordersUpdated = 0;
      for (const p of products) {
        const res = await learnProductStyle(tx, businessId, def.id, p);
        ordersUpdated += res.orders;
        learned.push({ product: p, ruleKind: res.ruleKind, ruleValue: res.ruleValue });
      }
      await logStyleLearning(tx, {
        businessId,
        actorId: user.id,
        action: "style.learned",
        metadata: { source: "styles_page", bulkConfirm: true, style: def.name, products: learned, ordersUpdated },
      });
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not confirm" };
  }
  revalidatePath("/styles");
  revalidatePath("/board");
  return { ok: true };
}
