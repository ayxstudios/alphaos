"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import { focusRing } from "@/components/ui/styles";
import { Tooltip } from "@/components/ui";
import type { Role } from "@/lib/auth/config";
import { adminExtraKeys, primaryNavKeys, type NavKey } from "@/lib/agent/nav";
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
  CheckCircle,
  Mail,
  Calendar,
  Eye,
  Sliders,
  type IconProps,
  Wallet,
  BookOpen,
} from "@/components/ui/icons";

type NavItem = { label: string; href: string; icon: ComponentType<IconProps> };

// Plain and short: the six groups a VA actually thinks in, plus Settings.
// Everything else (Customers, Portrait Styles, System Health) still exists —
// it just lives in the quieter "More" group below, so the main list stays
// calm and obvious instead of listing every page in the app.
const ITEMS: Record<NavKey, NavItem> = {
  home: { label: "Home", href: "/dashboard", icon: Grid },
  today: { label: "Today", href: "/today", icon: ListChecks },
  orders: { label: "Orders", href: "/orders", icon: Package },
  qc: { label: "QC", href: "/qc", icon: Eye },
  messages: { label: "Messages", href: "/emails", icon: Mail },
  overview: { label: "Overview", href: "/overview", icon: Sliders },
  day: { label: "Day", href: "/day", icon: CheckCircle },
  exceptions: { label: "Exceptions", href: "/exceptions", icon: AlertTriangle },
  boards: { label: "Boards", href: "/board", icon: Columns },
  print: { label: "Print", href: "/queue/print", icon: Truck },
  money: { label: "Money", href: "/payouts", icon: Wallet },
  settings: { label: "Settings", href: "/settings", icon: Settings },
};

// Agent mode (any agent switch on for the business): Day, Overview and
// Exceptions replace Today and QC. Switches off: the list is exactly as it was
// before the agent (lib/agent/nav.ts holds the rule).
const ADMIN_MORE: NavItem[] = [
  { label: "System Health", href: "/health", icon: AlertTriangle },
  { label: "Designers", href: "/designers", icon: Palette },
  { label: "Portrait Styles", href: "/styles", icon: Brush },
  { label: "Customers", href: "/customers", icon: Users },
];

// No Portrait Styles for VAs (Yousif 2026-10-01): Alpha matches styles to
// designers itself; when it can't, the question shows up on the VA home with a
// link straight to /styles (the page itself stays reachable for that case).
const VA_MORE: NavItem[] = [
  { label: "Designers", href: "/designers", icon: Palette },
  { label: "Customers", href: "/customers", icon: Users },
];

const DESIGNER_NAV: NavItem[] = [
  { label: "Home", href: "/dashboard", icon: Grid },
  { label: "My Board", href: "/board", icon: Columns },
  { label: "My Week", href: "/me", icon: Calendar },
];
const DESIGNER_MORE: NavItem[] = [];

// A designer's teammate: the board and the guide, nothing else (never pay).
const HELPER_NAV: NavItem[] = [
  { label: "Board", href: "/board", icon: Columns },
  { label: "Help", href: "/help", icon: BookOpen },
];

// VAs read the QC and orders pages by Yousif's names (2026-10-01).
const VA_LABELS: Partial<Record<NavKey, string>> = { qc: "Awaiting QC", orders: "All Orders Overview" };

function navFor(role: Role, agentMode = false): NavItem[] {
  if (role === "helper") return HELPER_NAV;
  if (role === "designer") return DESIGNER_NAV;
  const keys = primaryNavKeys(role === "admin" ? "admin" : "va", agentMode);
  return keys.map((k) => (role === "va" && VA_LABELS[k] ? { ...ITEMS[k], label: VA_LABELS[k]! } : ITEMS[k]));
}

/** The role's main menu pages, for the idle prefetcher (components/shell/idle-prefetch.tsx). */
export function mainNavHrefs(role: Role, agentMode = false): string[] {
  return navFor(role, agentMode).map((n) => n.href);
}

type SidebarProps = {
  role: Role;
  /** Any agent switch on for the active business (see lib/agent/nav.ts). */
  agentMode?: boolean;
  collapsed?: boolean;
  mobile?: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
};

export function Sidebar({
  role,
  agentMode = false,
  collapsed = false,
  mobile = false,
  onToggle,
  onNavigate,
}: SidebarProps) {
  const pathname = usePathname();
  const nav = navFor(role, agentMode);
  const more =
    role === "helper" || role === "designer"
      ? DESIGNER_MORE
      : role === "admin"
        ? [...adminExtraKeys(agentMode).map((k) => ITEMS[k]), ...ADMIN_MORE]
        : VA_MORE;
  const homeHref = role === "helper" ? "/board" : "/dashboard";

  function renderItem(item: NavItem) {
    const active = pathname === item.href || pathname.startsWith(item.href + "/");
    const Glyph = item.icon;
    const link = (
      <Link
        key={item.href}
        href={item.href}
        // Full prefetch (page data, not only the skeleton) as soon as the link
        // is in view, kept warm by idle-prefetch.tsx, so the click paints from
        // the router cache with no network (docs/PERF.md).
        prefetch={true}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        data-tour={`nav:${item.href}`}
        className={cn(
          "group relative flex items-center gap-3 rounded-input px-3 text-sm font-medium",
          // The phone drawer: 44px rows; the laptop sidebar keeps 40px.
          mobile ? "h-11" : "h-10",
          "transition-colors duration-150 ease-standard motion-hover",
          focusRing,
          collapsed && !mobile && "justify-center px-0",
          active ? "text-pigment" : "text-slate hover:bg-canvas hover:text-ink",
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
  }

  return (
    <aside
      className={cn(
        "flex h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-150 ease-standard",
        // In the phone drawer the panel sets the width: fill it, no blank strip.
        mobile ? "w-full" : collapsed ? "w-[4.5rem]" : "w-60",
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
          aria-label="AlphaOS home"
          className={cn("flex min-h-11 min-w-0 items-center gap-2 rounded-input", focusRing)}
        >
          {collapsed && !mobile ? (
            <span className="font-display text-lg font-semibold leading-5 text-pigment">α</span>
          ) : (
            <span className="min-w-0">
              <span className="block font-display text-lg font-semibold leading-5 text-ink">AlphaOS</span>
              <span className="block text-xs text-slate">Operations</span>
            </span>
          )}
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2">
        {/* Alpha AI is not a menu item: it has one way in, its tab in the top
            bar, which is on screen on every page on a laptop and a phone. */}
        {nav.map(renderItem)}
        {more.length > 0 && (
          <>
            <div className="my-3 h-px bg-line/70" />
            {more.map(renderItem)}
          </>
        )}
      </nav>

      {onToggle && !mobile && (
        <div className="border-t border-line p-2">
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
        </div>
      )}
    </aside>
  );
}
