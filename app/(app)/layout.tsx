import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { ToastProvider } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const user = { id: session.user.id, role: session.user.role };
  const { options, selected, unread } = await loadShellData(user);

  return (
    <div className="flex h-screen flex-col">
      {/* Accent bar — pigment, signals you're in a scoped context. */}
      <div className="h-1 shrink-0 bg-pigment" />
      <div className="flex min-h-0 flex-1">
        <Sidebar role={user.role} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            user={{
              name: session.user.name ?? session.user.email ?? "User",
              email: session.user.email ?? "",
              role: user.role,
            }}
            options={options}
            selected={selected}
            unread={unread}
          />
          {/* Active-business indicator, so nobody acts on the wrong shop. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-pigment-soft/50 px-6 py-1.5">
            <span className="size-1.5 rounded-full bg-pigment" />
            <span className="text-xs font-medium text-pigment">
              Viewing: {selected.name}
            </span>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
            <ToastProvider>{children}</ToastProvider>
          </main>
        </div>
      </div>
    </div>
  );
}
