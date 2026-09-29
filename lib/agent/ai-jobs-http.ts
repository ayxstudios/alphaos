import { NextResponse, type NextRequest } from "next/server";

import { secretsMatch } from "@/lib/secret-compare";
import { AiJobError } from "./ai-designer";

/**
 * Bearer auth for the AI designer jobs API. Fails closed: with AGENT_JOBS_TOKEN
 * unset every call is refused. Returns a response to send, or null when allowed.
 */
export function rejectUnlessAgent(req: NextRequest): NextResponse | null {
  const secret = process.env.AGENT_JOBS_TOKEN ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!secret || !secretsMatch(given, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

export function jobError(e: unknown): NextResponse {
  if (e instanceof AiJobError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
  throw e;
}
