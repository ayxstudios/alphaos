"use server";

import { AuthError, CredentialsSignin } from "next-auth";

import { signIn } from "@/lib/auth";

/** `email` comes back on an error so the form keeps it (React resets a form after its action). */
export type LoginState = { error?: string; email?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const redirectTo = safeBackPath(String(formData.get("callbackUrl") ?? ""));

  if (!email || !password) {
    return { error: "Enter your email and password.", email };
  }

  try {
    // On success this throws NEXT_REDIRECT (handled below by re-throwing).
    await signIn("credentials", { email, password, redirectTo });
  } catch (err) {
    if (err instanceof CredentialsSignin) {
      return {
        email,
        error:
          err.code === "locked"
            ? "Too many tries. Wait 15 minutes, then try again."
            : // Also what a deactivated account sees: calm, and it never says
              // whether the account exists.
              "Wrong email or password. Try again, or ask your admin.",
      };
    }
    if (err instanceof AuthError) {
      return { error: "Could not sign in just now. Try again.", email };
    }
    // Re-throw redirects (and anything else) so navigation happens.
    throw err;
  }

  return {};
}

/**
 * Where to land after sign-in: the page the person was sent from, only when
 * it is a path on this site ("/orders/abc"), never another host
 * ("//evil.example", "/\\evil", "https://...") and never the login page again.
 */
function safeBackPath(value: string): string {
  // Browsers drop tabs and newlines inside a URL, so "/\t/evil" would read as "//evil".
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\s\u0000-\u001f]/.test(value)) return "/";
  if (/^\/(login|api)(\/|$|\?)/.test(value)) return "/";
  return value;
}
