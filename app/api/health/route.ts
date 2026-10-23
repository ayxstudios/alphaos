import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { withSystemContext } from "@/lib/db";

// Always a live answer, never a cached one.
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 5000;

/**
 * Up = the app answers AND the database does (2026-10-23: the 16 Oct quota
 * outage returned 402 on every query while this route still said ok). One
 * `select 1` as the app login, so a wrong DATABASE_URL shows too; 503 when it
 * fails or takes longer than DB_TIMEOUT_MS. No tenant data is read.
 */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([withSystemContext((tx) => tx.execute(sql`select 1`)), timeout]);
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "db_down" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
