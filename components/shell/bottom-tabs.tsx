"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Grid, ListChecks, Package, Mail, Columns, Calendar, Menu, type IconProps } from "@/components/ui/icons";
import type { ComponentType } from "react";
import type { Role } from "@/lib/auth/config";

// Prefetch on touch start only. With Link's default prefetch every tab in
// view fired its own `?_rsc=` request during a cold load (7 to 9 of them on
// a 400 ms RTT phone pipe, docs/PERF.md), so viewport prefetch is off here
// (`prefetch={false}` also turns Link's own touch-start prefetch off in Next
// 15.5, hence the explicit one). A full prefetch, page data included, so
// the tap still lands on a ready page.
const TOUCH_PREFETCH = { kind: PrefetchKind.FULL };

type Tab = { label: string; href: string; icon: ComponentType<IconProps> };

const ADMIN_VA_TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: Grid },
  { label: "Today", href: "/today", icon: ListChecks },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Messages", href: "/emails", icon: Mail },
];

const DESIGNER_TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: Grid },
  { label: "My Board", href: "/board", icon: Columns },
  { label: "My Week", href: "/me", icon: Calendar },
];

/**
 * Phone-only sticky bottom navigation, for every role: admin/va get the
 * four places they live day to day (Home is the charts overview, the full
 * queue moved to /today); designers get their own three pages. "More" opens
 * the same mobile sidebar drawer for everything else. Alpha AI opens from
 * its tab in the top bar.
 */
export function BottomTabs({ role, onMore }: { role: Role; onMore: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const tabs = role === "designer" ? DESIGNER_TABS : ADMIN_VA_TABS;
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Glyph = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            prefetch={false}
            onTouchStart={() => {
              if (!active) router.prefetch(tab.href, TOUCH_PREFETCH);
            }}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
              focusRing,
              active ? "text-pigment" : "text-slate",
            )}
            aria-current={active ? "page" : undefined}
            data-tour={`tab:${tab.href}`}
          >
            <Glyph size={20} />
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        data-tour="tab:more"
        className={cn(
          "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium text-slate",
          focusRing,
        )}
      >
        <Menu size={20} />
        More
      </button>
    </nav>
  );
}
