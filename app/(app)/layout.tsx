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
  const [{ options, selected, unread, recentNotifications, displayName, onboarding }, cookieStore] = await Promise.all([
    loadShellData(user),
    cookies(),
  ]);
  const initialCollapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "1";
  const name = displayName ?? session.user.name ?? session.user.email ?? "User";

  return (
    <AppShell
      user={{
        name,
        email: session.user.email ?? "",
        role: user.role,
      }}
      options={options}
      selected={selected}
      unread={unread}
      recentNotifications={recentNotifications}
      initialCollapsed={initialCollapsed}
      tour={{
        firstName: name.split(/[\s@]+/)[0] || "there",
        onboarding,
        signedInAt: session.user.signedInAt ?? 0,
      }}
    >
      {children}
    </AppShell>
  );
}
