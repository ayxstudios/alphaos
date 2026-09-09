import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import type { RequestUser } from "@/lib/db";
import { loadShellData } from "@/lib/shell/context";
import { buildAlphaSnapshot } from "@/lib/alpha/snapshot";
import { chatAlpha, type AlphaChatMessage } from "@/lib/alpha/client";

export const runtime = "nodejs";

const MAX_TURNS = 12;
const MAX_CONTENT_CHARS = 2000;

function sanitizeMessages(input: unknown): AlphaChatMessage[] {
  if (!Array.isArray(input)) return [];
  const cleaned: AlphaChatMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const { role, content } = raw as Record<string, unknown>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    const trimmed = content.slice(0, MAX_CONTENT_CHARS);
    if (!trimmed.trim()) continue;
    cleaned.push({ role, content: trimmed });
  }
  return cleaned.slice(-MAX_TURNS);
}

/**
 * POST /api/alpha/chat -- the floating chat widget's only endpoint. Body:
 * { messages, page, orderId? }. Builds a role-scoped snapshot of live
 * numbers server-side (never trusts anything the client sends about its own
 * numbers), then hands the conversation to chatAlpha (lib/alpha/client.ts),
 * which itself never throws. This route therefore never returns an error
 * body to the widget -- only 401 (not signed in) short-circuits before that.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const user: RequestUser & { name: string } = {
    id: session.user.id,
    role: session.user.role,
    name: session.user.name ?? "Someone",
  };

  let body: { messages?: unknown; page?: unknown; orderId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages.length) {
    return NextResponse.json({ error: "messages is required" }, { status: 400 });
  }
  const page = typeof body.page === "string" ? body.page.slice(0, 300) : null;
  const orderId = typeof body.orderId === "string" && body.orderId.trim() ? body.orderId : null;

  const shell = await loadShellData(user);
  if (shell.displayName) user.name = shell.displayName;
  const businessId = shell.selected.id || null;

  const snapshot = await buildAlphaSnapshot(user, businessId).catch(() => null);

  const result = await chatAlpha({
    messages,
    askedBy: { userId: user.id, role: user.role, name: user.name },
    snapshot,
    page,
    orderId,
  });

  return NextResponse.json(result);
}
