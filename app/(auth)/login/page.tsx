import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">Sign in to AlphaOS</h1>
        <p className="text-sm opacity-70">
          Continue with Google or a magic link.
        </p>
      </div>

      {/* Google OAuth */}
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/dashboard" });
        }}
      >
        <button
          type="submit"
          className="w-full rounded-md border px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Continue with Google
        </button>
      </form>

      {/* Email magic link (Nodemailer provider — requires a DB adapter to work) */}
      <form
        action={async (formData: FormData) => {
          "use server";
          await signIn("nodemailer", {
            email: formData.get("email"),
            redirectTo: "/dashboard",
          });
        }}
        className="flex flex-col gap-2"
      >
        <input
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          className="rounded-md border px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded-md border px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Send magic link
        </button>
      </form>
    </div>
  );
}
