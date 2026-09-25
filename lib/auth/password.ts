import bcrypt from "bcryptjs";

const COST = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A real cost-12 hash of a random string nobody knows, computed once per
// process. Comparing against it costs the same time as a real account.
let dummyHash: Promise<string> | null = null;

/**
 * Spend the same bcrypt time as a real password check when there is no
 * account to check (unknown email, no password set, deactivated): without it
 * a wrong password on a real email answered about 400 ms slower than on an
 * unknown one, which told anyone which emails have accounts (customer +
 * security QA 2026-09-25). Always resolves false.
 */
export async function burnPasswordCheck(plain: string): Promise<false> {
  dummyHash ??= bcrypt.hash(`no-account-${Math.random()}-${Date.now()}`, COST);
  await bcrypt.compare(plain, await dummyHash);
  return false;
}
