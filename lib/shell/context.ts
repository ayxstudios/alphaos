import { cookies } from "next/headers";
import { and, eq, isNull, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses as businessesTable, notifications } from "@/lib/db/schema";
import { BUSINESS_COOKIE } from "@/lib/shell/constants";

export const ALL_BUSINESSES = "all";

export type BusinessOption = { id: string; name: string };

export type ShellData = {
  /** Options for the switcher (includes "All Businesses" for admin). */
  options: BusinessOption[];
  /** The active selection, resolved from the cookie (validated). */
  selected: BusinessOption;
  /** Unread notification count for the current user. */
  unread: number;
};

/**
 * Loads everything the app shell needs. All reads go through withUserContext so
 * RLS scopes them: admin/va see all businesses, a designer only their own.
 */
export async function loadShellData(user: RequestUser): Promise<ShellData> {
  const businesses = await withUserContext(user, (tx) =>
    tx
      .select({ id: businessesTable.id, name: businessesTable.name })
      .from(businessesTable)
      .orderBy(businessesTable.name),
  );

  const unreadRows = await withUserContext(user, (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        and(eq(notifications.userId, user.id), isNull(notifications.readAt)),
      ),
  );
  const unread = unreadRows[0]?.n ?? 0;

  // Only admin gets the cross-business "All Businesses" view.
  const options: BusinessOption[] =
    user.role === "admin"
      ? [{ id: ALL_BUSINESSES, name: "All Businesses" }, ...businesses]
      : businesses;

  const cookieVal = (await cookies()).get(BUSINESS_COOKIE)?.value;
  const selected =
    options.find((o) => o.id === cookieVal) ??
    options[0] ?? { id: ALL_BUSINESSES, name: "All Businesses" };

  return { options, selected, unread };
}
