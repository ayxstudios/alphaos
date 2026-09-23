/**
 * Operator CLI for per-person sign-in links (lib/auth/login-link.ts,
 * docs/LOGIN-LINKS.md).
 *
 *   npx tsx scripts/login-link.ts <email> [--days 90] [--base https://app.example]
 *       make (or replace) that person's link; prints the full URL ONCE
 *   npx tsx scripts/login-link.ts --revoke <email>
 *       stop their link working
 *
 * The URL is a credential: anyone holding it signs in as that person. Send it to
 * them directly. The base is NEXT_PUBLIC_APP_URL unless --base is given.
 *
 * Uses the raw `db` handle like lib/auth: login_links and "user" have no RLS,
 * and an operator script runs as no signed-in user. Mint = revoke the old link
 * + insert the new one in one transaction.
 */
import "./load-env";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";
import { users } from "../lib/db/schema";
import { LINK_DEFAULT_DAYS, linkDays, loginLinkUrl, mintLoginLinkTx, revokeLoginLinksTx } from "../lib/auth/login-link";

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error("Usage:");
  console.error(`  npx tsx scripts/login-link.ts <email> [--days ${LINK_DEFAULT_DAYS}] [--base <app url>]`);
  console.error("  npx tsx scripts/login-link.ts --revoke <email>");
  process.exit(1);
}

function isLocalUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let revoke = false;
  let days = LINK_DEFAULT_DAYS;
  let base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  let email = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--revoke") revoke = true;
    else if (a === "--days") days = linkDays(args[++i]);
    else if (a === "--base") base = args[++i] ?? "";
    else if (a === "--help" || a === "-h") usage();
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else email = a.trim().toLowerCase();
  }
  if (!email || !email.includes("@")) usage("give the person's email");

  const [user] = await db
    .select({ id: users.id, name: users.name, active: users.active })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) usage(`no account with the email ${email}`);

  if (revoke) {
    const n = await db.transaction((tx) => revokeLoginLinksTx(tx, user.id));
    console.log(n ? `Revoked the sign-in link for ${email}.` : `${email} had no active sign-in link.`);
    return;
  }

  if (!user.active) usage(`${email} is deactivated; reactivate them first`);
  if (!base) usage("NEXT_PUBLIC_APP_URL is not set; pass --base <app url>");
  if (isLocalUrl(base) && !isLocalUrl(process.env.DATABASE_URL?.replace(/^postgres(ql)?:/, "http:"))) {
    console.error(`Warning: the link points at ${base} but the database is not local. Pass --base <app url>.`);
  }

  const minted = await db.transaction((tx) => mintLoginLinkTx(tx, { userId: user.id, createdBy: null, days }));
  const until = minted.expiresAt.toISOString().slice(0, 10);
  console.log(`Sign-in link for ${user.name ?? email} (${email}), works until ${until}. Shown once:`);
  console.log(loginLinkUrl(minted.token, base));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("login-link failed:", err);
    process.exit(1);
  });
