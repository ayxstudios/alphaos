import { eq } from "drizzle-orm";

import type { Tx } from "@/lib/db";
import { designerProfiles, users } from "@/lib/db/schema";
import { DEFAULT_TIMEZONE, isValidTimezone } from "./quiet-hours";

export type PreferredChannel = "whatsapp" | "telegram";

/** The contact + working-hours part of a designer profile (what Alpha needs). */
export type DesignerContact = {
  userId: string;
  name: string;
  phone: string | null;
  preferredChannel: PreferredChannel;
  /** Always a valid IANA name (falls back to DEFAULT_TIMEZONE). */
  timezone: string;
  /** Null when the designer never set one; UI shows "not set". */
  timezoneRaw: string | null;
  quietStart: string | null;
  quietEnd: string | null;
  maxActiveOrders: number;
};

export function asChannel(v: string | null | undefined): PreferredChannel {
  return v === "telegram" ? "telegram" : "whatsapp";
}

/** One designer's contact profile, or null if they have no profile row. */
export async function loadDesignerContact(tx: Tx, designerId: string): Promise<DesignerContact | null> {
  const [row] = await tx
    .select({
      userId: designerProfiles.userId,
      name: users.name,
      phone: designerProfiles.phone,
      preferredChannel: designerProfiles.preferredChannel,
      timezone: designerProfiles.timezone,
      quietStart: designerProfiles.quietStart,
      quietEnd: designerProfiles.quietEnd,
      maxActiveOrders: designerProfiles.maxActiveOrders,
    })
    .from(designerProfiles)
    .innerJoin(users, eq(users.id, designerProfiles.userId))
    .where(eq(designerProfiles.userId, designerId))
    .limit(1);
  if (!row) return null;
  return {
    userId: row.userId,
    name: row.name ?? "Designer",
    phone: row.phone,
    preferredChannel: asChannel(row.preferredChannel),
    timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
    timezoneRaw: row.timezone,
    quietStart: row.quietStart,
    quietEnd: row.quietEnd,
    maxActiveOrders: row.maxActiveOrders,
  };
}
