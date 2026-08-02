/**
 * QC checklist configuration and snapshotting.
 *
 * The ten default items are the house QC standard (see CLAUDE.md / the QC
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

/** The house standard — ten items, in the order a VA scans them. */
export const DEFAULT_CHECKLIST: ChecklistItem[] = [
  { key: 1, label: "Portrait style is correct — matches house style, not too realistic or cartoonish" },
  { key: 2, label: "Rings and jewellery match the reference photo exactly" },
  { key: 3, label: "All tattoos present and accurately hand-drawn" },
  { key: 4, label: "Visible text (clothing, signs) is correct and legible" },
  { key: 5, label: "Eye colour is accurate" },
  { key: 6, label: "Pet fur colour, markings, and texture match the reference" },
  { key: 7, label: "Hair colour and hairstyle are accurate" },
  { key: 8, label: "Hands and fingers anatomically correct — no missing or extra fingers" },
  { key: 9, label: "Ear shape matches the reference" },
  { key: 10, label: "Number of hands, people, and pets is correct — nothing added, removed or duplicated" },
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

/** Keyboard hint for an item: 1–9, then 0 for the tenth. */
export function shortcutFor(key: number): string {
  return String(key % 10);
}
