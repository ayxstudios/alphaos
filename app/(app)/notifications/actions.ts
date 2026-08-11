"use server";

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { withUserContext } from "@/lib/db";
import { notifications } from "@/lib/db/schema";

export async function markAllNotificationsRead(): Promise<void> {
  const session = await auth();
  if (!session?.user) return;
  const user = { id: session.user.id, role: session.user.role };
  await withUserContext(user, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt))),
  );
  revalidatePath("/");
}
