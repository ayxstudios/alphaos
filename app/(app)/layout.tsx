import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { AppShell, SIDEBAR_COOKIE } from "@/components/shell/app-shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const user = { id: session.user.id, role: session.user.role };
  const [{ options, selected, unread }, cookieStore] = await Promise.all([
    loadShellData(user),
    cookies(),
  ]);
  const initialCollapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";

  return (
    <AppShell
      user={{
        name: session.user.name ?? session.user.email ?? "User",
        email: session.user.email ?? "",
        role: user.role,
      }}
      options={options}
      selected={selected}
      unread={unread}
      initialCollapsed={initialCollapsed}
    >
      {children}
    </AppShell>
  );
}
