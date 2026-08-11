import { cache } from "react";
import { cookies } from "next/headers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { withUserContext, type RequestUser } from "@/lib/db";
import { businesses as businessesTable, notifications } from "@/lib/db/schema";
import { BUSINESS_COOKIE } from "@/lib/shell/constants";
import { fallbackNotificationTitle, type NotificationVM } from "@/lib/notifications/types";

export type BusinessOption = { id: string; name: string };

export type ShellData = {
  /** Options for the switcher. Staff work in one business at a time. */
  options: BusinessOption[];
  /** The active selection, resolved from the cookie (validated). */
  selected: BusinessOption;
  /** Unread notification count for the current user. */
  unread: number;
  recentNotifications: NotificationVM[];
};

/**
 * Loads everything the app shell needs. All reads go through withUserContext so
 * RLS scopes the business list to what this user may access.
 *
 * Wrapped in React `cache()` keyed on the user's id+role (primitives, so the
 * memo actually hits) — the layout and the page both call this in the same
 * request, and this collapses them to a single set of queries. Both reads run
 * in ONE transaction (one WebSocket round-trip of setup), not two.
 */
export function loadShellData(user: RequestUser): Promise<ShellData> {
  return loadShellCached(user.id, user.role);
}

const loadShellCached = cache(
  async (userId: string, role: RequestUser["role"]): Promise<ShellData> => {
    const user: RequestUser = { id: userId, role };
    const { businesses, unread, recentNotifications } = await withUserContext(user, async (tx) => {
      const businesses = await tx
        .select({ id: businessesTable.id, name: businessesTable.name })
        .from(businessesTable)
        .orderBy(businessesTable.name);
      const [unreadRow] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
      const recentRows = await tx
        .select({
          id: notifications.id,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          href: notifications.href,
          createdAt: notifications.createdAt,
        })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
        .orderBy(desc(notifications.createdAt))
        .limit(8);
      return {
        businesses,
        unread: unreadRow?.n ?? 0,
        recentNotifications: recentRows.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title ?? fallbackNotificationTitle(n.type),
          body: n.body,
          href: n.href,
          createdAt: n.createdAt.toISOString(),
        })),
      };
    });

    const options: BusinessOption[] = businesses;

    const cookieVal = (await cookies()).get(BUSINESS_COOKIE)?.value;
    const selected =
      options.find((o) => o.id === cookieVal) ??
      options[0] ?? { id: "", name: "No workspace" };

    return { options, selected, unread, recentNotifications };
  },
);
