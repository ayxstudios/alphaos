"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/lib/auth";
import { withUserContext, type RequestUser } from "@/lib/db";
import { getShopCredentials, setShopCredentials } from "@/lib/db/credentials";
import {
  syncShopReceipts,
  type SyncSummary,
  type EtsyCredentials,
} from "@/lib/integrations/etsy";

async function requireAdmin(): Promise<RequestUser> {
  const session = await auth();
  if (session?.user?.role !== "admin") throw new Error("Forbidden");
  return { id: session.user.id, role: "admin" };
}

/** Save a shop's Etsy app credentials (keystring + shared secret). Form action. */
export async function saveEtsyCredentials(formData: FormData): Promise<void> {
  const user = await requireAdmin();
  const shopId = String(formData.get("shopId") ?? "");
  const keystring = String(formData.get("keystring") ?? "").trim();
  const sharedSecret = String(formData.get("sharedSecret") ?? "").trim();
  if (!shopId || !keystring || !sharedSecret) throw new Error("Missing fields");

  await withUserContext(user, async (tx) => {
    const creds = (await getShopCredentials(tx, shopId)) as EtsyCredentials;
    await setShopCredentials(tx, shopId, { ...creds, keystring, sharedSecret });
  });
  revalidatePath("/settings");
}

export async function triggerSync(shopId: string): Promise<SyncSummary> {
  await requireAdmin();
  const summary = await syncShopReceipts(shopId);
  revalidatePath("/settings");
  return summary;
}
