// Which primary nav items a signed-in role sees (docs/AGENT_FIRST.md). Pure, so
// the sidebar, the phone tab bar and the test all read the same rule.
//
// Agent mode: when ANY agent flag is on for the active business, Day replaces
// Today and QC, and Overview and Exceptions show for VAs and admins. All flags
// off is nav exactly as on main. Routes stay reachable by URL either way.
export type NavKey =
  | "home"
  | "today"
  | "orders"
  | "qc"
  | "messages"
  | "overview"
  | "day"
  | "exceptions"
  | "boards"
  | "print"
  | "money"
  | "settings";

export type NavRole = "admin" | "va" | "designer";

export type AgentFlags = {
  agentIntakeEnabled?: boolean | null;
  agentAssignEnabled?: boolean | null;
  agentInboxEnabled?: boolean | null;
};

export function isAgentMode(flags: AgentFlags | null | undefined): boolean {
  return !!(flags?.agentIntakeEnabled || flags?.agentAssignEnabled || flags?.agentInboxEnabled);
}

const ADMIN_OFF: NavKey[] = ["home", "today", "orders", "qc", "messages", "boards", "print", "money", "settings"];
// VA menu as Yousif set it on 2026-10-01; agent mode only adds Exceptions
// (what the agent hands to a human). VAs QC and approve print drafts.
const VA_OFF: NavKey[] = ["home", "qc", "messages", "boards", "print", "orders"];
const ADMIN_ON: NavKey[] = ["home", "day", "overview", "exceptions", "orders", "messages", "boards", "print", "money", "settings"];
const VA_ON: NavKey[] = ["home", "qc", "exceptions", "messages", "boards", "print", "orders"];

/** Ordered primary nav keys for a staff role. Designers have their own fixed nav. */
export function primaryNavKeys(role: NavRole, agentMode: boolean): NavKey[] {
  if (role === "designer") return ["home"];
  if (role === "admin") return agentMode ? ADMIN_ON : ADMIN_OFF;
  return agentMode ? VA_ON : VA_OFF;
}

/** The phone bottom tab bar: four places, the day's work first in agent mode. */
export function tabNavKeys(agentMode: boolean): NavKey[] {
  return agentMode ? ["home", "day", "orders", "messages"] : ["home", "today", "orders", "messages"];
}

/**
 * Admins keep a way to the agent's screens when the flags are off: Overview and
 * Exceptions sit in the quieter More group instead of the main list.
 */
export function adminExtraKeys(agentMode: boolean): NavKey[] {
  return agentMode ? [] : ["overview", "exceptions"];
}
