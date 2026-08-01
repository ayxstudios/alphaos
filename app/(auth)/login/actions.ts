"use server";

import { AuthError, CredentialsSignin } from "next-auth";

import { signIn } from "@/lib/auth";

export type LoginState = { error?: string };

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  try {
    // On success this throws NEXT_REDIRECT (handled below by re-throwing).
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (err) {
    if (err instanceof CredentialsSignin) {
      return {
        error:
          err.code === "locked"
            ? "Too many failed attempts. Try again in 15 minutes."
            : "Invalid email or password.",
      };
    }
    if (err instanceof AuthError) {
      return { error: "Something went wrong. Please try again." };
    }
    // Re-throw redirects (and anything else) so navigation happens.
    throw err;
  }

  return {};
}
