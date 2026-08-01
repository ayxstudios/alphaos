import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-3xl font-semibold">AlphaOS</h1>
      <p className="text-sm opacity-70">
        Operations platform for multi-channel commerce.
      </p>
      <div className="flex gap-3">
        <Link
          href="/login"
          className="rounded-md border px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Sign in
        </Link>
        <Link
          href="/dashboard"
          className="rounded-md border px-4 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10"
        >
          Dashboard
        </Link>
      </div>
    </main>
  );
}
