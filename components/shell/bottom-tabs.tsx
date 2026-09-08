"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Grid, Package, Mail, Menu, type IconProps } from "@/components/ui/icons";
import type { ComponentType } from "react";

type Tab = { label: string; href: string; icon: ComponentType<IconProps> };

const TABS: Tab[] = [
  { label: "Today", href: "/dashboard", icon: Grid },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Messages", href: "/emails", icon: Mail },
];

/**
 * Phone-only sticky bottom navigation for admin/va: the three places a VA
 * actually lives, plus More for everything else. Designers have a single
 * page (My Board) so they keep the plain top bar instead of this.
 */
export function BottomTabs({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Glyph = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "flex min-h-11 flex-1 flex-col items-center justify-center gap-1 text-xs font-medium",
              focusRing,
              active ? "text-pigment" : "text-slate",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Glyph size={20} />
            {tab.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
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
