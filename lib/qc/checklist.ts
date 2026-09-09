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

/** The house standard: five checks, in the order a VA scans them (owner 2026-09-09). */
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { key: 1, label: "Likeness: faces, eye colour, hair colour and hairstyle match the reference photos" },
  { key: 2, label: "Count: number of people, pets and hands matches the order, nothing added, removed or duplicated" },
  { key: 3, label: "Style: matches the ordered style and the house look, not too realistic or cartoonish" },
  { key: 4, label: "Details: jewellery, tattoos, pet markings and any visible text are correct and legible" },
  { key: 5, label: "Anatomy and finish: hands, fingers and ears are correct, no artefacts, edges clean at print size" },
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
