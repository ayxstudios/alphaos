"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Tooltip } from "@/components/ui";
import type { Role } from "@/lib/auth/config";
import {
  Grid,
  Package,
  Columns,
  Palette,
  Brush,
  ListChecks,
  Truck,
  Users,
  Settings,
  AlertTriangle,
  Mail,
  type IconProps,
} from "@/components/ui/icons";

type NavItem = { label: string; href: string; icon: ComponentType<IconProps> };

const ADMIN_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: Grid },
  { label: "System Health", href: "/health", icon: AlertTriangle },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Emails", href: "/emails", icon: Mail },
  { label: "Boards", href: "/board", icon: Columns },
  { label: "Ready to Print", href: "/queue/print", icon: Truck },
  { label: "Designers", href: "/designers", icon: Palette },
  { label: "Portrait Styles", href: "/styles", icon: Brush },
  { label: "Payouts", href: "/payouts", icon: ListChecks },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Settings", href: "/settings", icon: Settings },
];

const VA_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: Grid },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Emails", href: "/emails", icon: Mail },
  { label: "Boards", href: "/board", icon: Columns },
  { label: "Ready to Print", href: "/queue/print", icon: Truck },
  { label: "Designers", href: "/designers", icon: Palette },
  { label: "Portrait Styles", href: "/styles", icon: Brush },
  { label: "Customers", href: "/customers", icon: Users },
];

const DESIGNER_NAV: NavItem[] = [
  { label: "My Board", href: "/board", icon: Columns },
];

type SidebarProps = {
  role: Role;
  collapsed?: boolean;
  mobile?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
};

export function Sidebar({
  role,
  collapsed = false,
  mobile = false,
  onToggle,
  onNavigate,
}: SidebarProps) {
  const pathname = usePathname();
  const nav = role === "designer" ? DESIGNER_NAV : role === "admin" ? ADMIN_NAV : VA_NAV;
  const homeHref = role === "designer" ? "/board" : "/dashboard";

  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 ease-standard",
        collapsed && !mobile ? "w-[4.5rem]" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-16 items-center gap-3 px-4",
          collapsed && !mobile && "justify-center px-3",
        )}
      >
        <Link
          href={homeHref}
          onClick={onNavigate}
          aria-label="AlphaOS dashboard"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-input bg-pigment text-surface font-display text-base font-bold",
            focusRing,
          )}
        >
          A
        </Link>
        {(!collapsed || mobile) && (
          <div className="min-w-0">
            <p className="font-display text-lg font-semibold leading-5 text-ink">
              AlphaOS
            </p>
            <p className="text-xs text-slate">Operations</p>
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-2 py-2">
        {nav.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Glyph = item.icon;
          const link = (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex h-10 items-center gap-3 rounded-input px-3 text-sm font-medium",
                "transition-colors duration-150 ease-standard motion-hover",
                focusRing,
                collapsed && !mobile && "justify-center px-0",
                active
                  ? "text-pigment"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
              <span
                className={cn(
                  "absolute left-0 top-2 h-6 w-0.5 rounded-full bg-pigment opacity-0 transition-opacity",
                  active && "opacity-100",
                )}
              />
              <Glyph size={18} className="shrink-0" />
              {(!collapsed || mobile) && <span>{item.label}</span>}
            </Link>
          );
          return collapsed && !mobile ? (
            <Tooltip key={item.href} content={item.label} side="right">
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      <div className="border-t border-line p-2">
        {onToggle && !mobile && (
          <button
            type="button"
            onClick={onToggle}
            className={cn(
              "flex h-10 w-full items-center justify-center rounded-input text-sm font-medium text-slate transition-colors hover:bg-canvas hover:text-ink",
              focusRing,
            )}
          >
            <span className="sr-only">
              {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </span>
            <Columns size={17} className={cn(collapsed && "rotate-180")} />
            {!collapsed && <span className="ml-2">Collapse</span>}
          </button>
        )}
      </div>
    </aside>
  );
}
