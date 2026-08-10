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
  Users,
  Settings,
  type IconProps,
} from "@/components/ui/icons";

type NavItem = { label: string; href: string; icon: ComponentType<IconProps> };

const STAFF_NAV: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: Grid },
  { label: "Orders", href: "/orders", icon: Package },
  { label: "Boards", href: "/board", icon: Columns },
  { label: "Designers", href: "/designers", icon: Palette },
  { label: "Portrait Styles", href: "/styles", icon: Brush },
  { label: "Customers", href: "/customers", icon: Users },
  { label: "Settings", href: "/settings", icon: Settings },
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
  const nav = role === "designer" ? DESIGNER_NAV : STAFF_NAV;

  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 ease-standard",
        collapsed && !mobile ? "w-[4.5rem]" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-16 items-center gap-2.5 px-4",
          collapsed && !mobile && "justify-center px-3",
        )}
      >
        <Link
          href="/dashboard"
          onClick={onNavigate}
          aria-label="AlphaOS dashboard"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-ink font-display text-base text-canvas",
            focusRing,
          )}
        >
          A
        </Link>
        {(!collapsed || mobile) && (
          <div className="min-w-0">
            <p className="font-display text-lg leading-5 text-ink">AlphaOS</p>
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate">
              Operations
            </p>
          </div>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3 py-3">
        {(!collapsed || mobile) && (
          <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate/70">
            Workspace
          </p>
        )}
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
                  ? "bg-pigment text-surface shadow-sm"
                  : "text-slate hover:bg-canvas hover:text-ink",
              )}
            >
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
