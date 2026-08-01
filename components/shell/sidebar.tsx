"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import type { Role } from "@/lib/auth/config";
import {
  Grid,
  Package,
  Columns,
  ListChecks,
  Users,
  Settings,
  type IconProps,
} from "@/components/ui/icons";

type NavItem = { label: string; href: string; icon: ComponentType<IconProps> };

const STAFF_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: Grid },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Board", href: "/board", icon: Columns },
  { label: "Queue", href: "/queue", icon: ListChecks },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Settings", href: "/settings", icon: Settings },
];

const DESIGNER_NAV: NavItem[] = [
  { label: "My Board", href: "/board", icon: Columns },
];

export function Sidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const nav = role === "designer" ? DESIGNER_NAV : STAFF_NAV;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="flex size-8 items-center justify-center rounded-input bg-pigment text-surface font-display text-base font-bold">
          A
        </span>
        <span className="font-display text-lg font-semibold text-ink">
          AlphaOS
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        {nav.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Glyph = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-input px-3 py-2 text-sm font-medium",
                "transition-colors motion-hover",
                focusRing,
                active
                  ? "bg-pigment-soft text-pigment"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              <Glyph size={18} className="shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
