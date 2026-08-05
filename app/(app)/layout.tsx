import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { AppShell } from "@/components/shell/app-shell";

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
    <AppShell
      user={{
        name: session.user.name ?? session.user.email ?? "User",
        email: session.user.email ?? "",
        role: user.role,
      }}
      options={options}
      selected={selected}
      unread={unread}
    >
      {children}
    </AppShell>
  );
}
