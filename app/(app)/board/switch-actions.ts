"use server";

import { auth } from "@/lib/auth";
import { getDesignerBoard, type DesignerBoard } from "@/lib/orders/board-data";
import { loadShellData } from "@/lib/shell/context";

/**
 * One designer's board for the staff board switcher (components/board/
 * board-switcher.tsx): the same data the /board page renders for ?designer=,
 * scoped to the business selected in the shell. Staff only.
 */
export async function fetchDesignerBoard(designerId: string): Promise<DesignerBoard | null> {
  const session = await auth();
  if (!session?.user) return null;
  const user = { id: session.user.id, role: session.user.role };
  if (user.role !== "admin" && user.role !== "va") return null;
  if (typeof designerId !== "string" || !designerId) return null;
  const { selected } = await loadShellData(user);
  return getDesignerBoard(user, designerId, selected?.id || undefined);
}
