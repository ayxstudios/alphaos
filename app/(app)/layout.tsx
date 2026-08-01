import Link from "next/link";

// Authenticated app shell.
//
// TODO(auth): gate this layout once the session strategy is finalized, e.g.
//   import { auth } from "@/lib/auth";
//   const session = await auth();
//   if (!session) redirect("/login");
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <Link href="/dashboard" className="font-semibold">
          AlphaOS
        </Link>
        <nav className="flex gap-4 text-sm">
          <Link href="/dashboard" className="opacity-70 hover:opacity-100">
            Dashboard
          </Link>
        </nav>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
