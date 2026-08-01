"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { signOut } from "@/lib/auth";
import { BUSINESS_COOKIE } from "@/lib/shell/constants";

/** Persist the active business selection (see BUSINESS_COOKIE / loadShellData). */
export async function setBusiness(businessId: string): Promise<void> {
  const store = await cookies();
  store.set(BUSINESS_COOKIE, businessId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
