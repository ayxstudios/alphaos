/**
 * QC checklist configuration and snapshotting.
 *
 * The five default items are the house QC standard (see CLAUDE.md / the QC
 * brief). Shops may diverge later: a shop's checklist is read from
 * `shops.integrationConfig.checklist` when present, otherwise the default is
 * used. `shops.checklistVersion` numbers the standard so an audit can tell which
 * list applied at the time — the exact list used is snapshotted onto the
 * qc_checks row when a VA passes or fails.
 */

export type ChecklistItem = {
  /** Stable 1-based position. Keyboard shortcut is `key % 10` (10 -> "0"). */
  key: number;
  label: string;
};

export type ChecklistSnapshot = {
  version: number;
  items: ChecklistItem[];
};

/** Per-item pass/fail, keyed by item key. true = passed. */
export type ItemResults = Record<number, boolean>;

/**
 * The house standard: five checks, in the order a VA scans them (owner 2026-09-09).
 * Each label is "Name: what to look for", short enough to read at a glance
 * (simplicity pass 2026-09-25); the board shows the name part only.
 */
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { key: 1, label: "Likeness: faces, eyes and hair match the photos" },
  { key: 2, label: "Count: right number of people and pets, nothing extra or missing" },
  { key: 3, label: "Style: the style they ordered, not too real, not too cartoon" },
  { key: 4, label: "Details: jewellery, tattoos, markings and any words are right" },
  { key: 5, label: "Finish: hands, fingers and ears look right, edges are clean" },
];

/**
 * Resolve the checklist that applies to a shop, as an immutable snapshot to
 * stamp on the qc_checks row. Falls back to the default list; a shop overrides
 * by storing `{ checklist: ChecklistItem[] }` in integrationConfig.
 */
export function resolveChecklist(shop: {
  checklistVersion: number;
  integrationConfig: unknown;
}): ChecklistSnapshot {
  const custom = extractCustomChecklist(shop.integrationConfig);
  return {
    version: shop.checklistVersion,
    items: custom ?? DEFAULT_CHECKLIST,
  };
}

function extractCustomChecklist(config: unknown): ChecklistItem[] | null {
  if (!config || typeof config !== "object") return null;
  const raw = (config as { checklist?: unknown }).checklist;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const items: ChecklistItem[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as ChecklistItem).key === "number" &&
      typeof (entry as ChecklistItem).label === "string"
    ) {
      items.push({ key: (entry as ChecklistItem).key, label: (entry as ChecklistItem).label });
    }
  }
  return items.length ? items : null;
}

/** Keyboard hint for an item: 1-9, then 0 for a tenth. */
export function shortcutFor(key: number): string {
  return String(key % 10);
}

/** "Likeness: faces, eyes and hair match the photos" -> { name, hint }. */
export function splitChecklistLabel(label: string): { name: string; hint: string } {
  const i = label.indexOf(":");
  if (i <= 0) return { name: label, hint: "" };
  return { name: label.slice(0, i).trim(), hint: label.slice(i + 1).trim() };
}
