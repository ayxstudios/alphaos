import { redirect } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@/lib/auth";
import { loadShellData } from "@/lib/shell/context";
import { greetingFor } from "@/lib/home/shared";
import { Page } from "@/components/ui";
import { StaffHome } from "@/components/home/staff-home";
import { DesignerHome } from "@/components/home/designer-home";
import { SectionSkeleton, TileSkeleton } from "@/components/home/primitives";

export const dynamic = "force-dynamic";

/**
 * Home: the first screen after login, for every role. A short greeting, four
 * numbers, then a calm set of charts scoped to what this person can act on.
 * The full ranked queue moved to /today so this page never becomes a wall.
 */
export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const user = { id: session.user.id, role: session.user.role };
  const { selected, displayName } = await loadShellData(user);
  const first = (displayName ?? session.user.name ?? "there").split(/\s+/)[0];

  return (
    <Page className="max-w-6xl">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-slate">{selected.name}</p>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {greetingFor()}, {first}.
        </h1>
      </div>
      <Suspense
        fallback={
          <div className="flex flex-col gap-5">
            <TileSkeleton />
            <SectionSkeleton h={260} />
            <SectionSkeleton h={260} />
          </div>
        }
      >
        {user.role === "designer" ? <DesignerHome user={user} /> : <StaffHome user={user} businessId={selected.id} role={user.role} />}
      </Suspense>
    </Page>
  );
}
