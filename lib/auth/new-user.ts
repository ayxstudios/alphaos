import { hashPassword } from "./password";
import type { Role } from "./config";

/**
 * The one way a "user" row is minted: `npm run create-user`, the roster's Add
 * designer, and the admin Team panel (Add VA / Add admin, lib/team/manage.ts)
 * all build their insert values here, so emails are normalised and passwords
 * hashed the same way everywhere. The clear password is never stored or logged.
 */

export const ROLES = ["admin", "va", "designer"] as const satisfies readonly Role[];
export const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Server actions are callable by hand with any JSON: a non-string field is
// treated as empty (a calm "Enter their name"), never a TypeError and a 500.
export function normalizeEmail(raw: string): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function normalizeName(raw: string): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

/** A calm message for the first thing wrong with the input, or null when it is fine. */
export function newUserProblem(input: { name: string; email: string; password: string }): string | null {
  const name = normalizeName(input.name);
  const email = normalizeEmail(input.email);
  if (name.length < 2 || name.length > 80) return "Enter their name";
  if (!EMAIL_RE.test(email) || email.length > 200) return "Enter a valid email address";
  return passwordProblem(input.password);
}

export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    return `The password needs at least ${MIN_PASSWORD} characters`;
  }
  if (password.length > 200) return "That password is too long";
  return null;
}

export async function newUserRow(input: {
  name: string;
  email: string;
  role: Role;
  password: string;
}): Promise<{ name: string; email: string; role: Role; passwordHash: string }> {
  return {
    name: normalizeName(input.name),
    email: normalizeEmail(input.email),
    role: input.role,
    passwordHash: await hashPassword(input.password),
  };
}
