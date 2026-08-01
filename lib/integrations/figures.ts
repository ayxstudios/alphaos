/**
 * Shared figure-count resolver for all integrations.
 *
 * Etsy variations and Shopify variant options are different shapes, but each
 * integration normalizes them to {name, value} and the rules/heuristic/
 * unresolved logic below is identical. figure_count drives payouts, so this
 * NEVER guesses a number when unsure — wrong is worse than unknown.
 */

/** A single figure-count rule (shops.integration_config.figureRules[]). */
export type FigureRule = {
  /** Case-insensitive substring matched against the variation's name. */
  match: string;
  /** How to derive the count from the variation's value. */
  type: "integer" | "map";
  /** For type "map": exact value (lowercased) -> count. */
  map?: Record<string, number>;
};

/** The figure-resolution slice of a shop's integration config. */
export type FigureConfig = {
  figureRules?: FigureRule[];
  allowHeuristicFigureCount?: boolean; // default false
};

/** An integration-agnostic name/value option pair. */
export type NormalizedVariation = { name: string; value: string };

export type FigureResolution = {
  count: number | null;
  source: "shop_rule" | "heuristic" | "unresolved";
  /** Short human-readable note on how it was decided (for activity_log). */
  note: string;
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// Nouns that plausibly denote the subjects being drawn.
const SUBJECT_NOUN = /(people|person|persons|figures?|pets?|subjects?|characters?|faces?)/i;

/**
 * Resolve a line item's figure count. Order: per-shop rules (high confidence),
 * then an OPT-IN generic heuristic, else unresolved.
 */
export function resolveFigureCount(
  variations: NormalizedVariation[],
  config: FigureConfig | null | undefined,
): FigureResolution {
  const rules = config?.figureRules ?? [];

  // 1. Per-shop rules.
  for (const rule of rules) {
    const v = variations.find((x) =>
      x.name?.toLowerCase().includes(rule.match.toLowerCase()),
    );
    if (!v) continue;
    const count = applyRule(rule, v.value);
    if (count != null) {
      return {
        count,
        source: "shop_rule",
        note: `rule "${rule.match}" matched "${v.name}: ${v.value}"`,
      };
    }
    // Rule owns this variation but the value didn't parse — do not guess.
    return {
      count: null,
      source: "unresolved",
      note: `rule "${rule.match}" matched "${v.name}" but value "${v.value}" was unparseable`,
    };
  }

  // 2. Generic heuristic — opt-in per shop (default off).
  if (config?.allowHeuristicFigureCount) {
    const found = heuristicCounts(variations);
    if (found.size === 1) {
      const count = [...found][0];
      return { count, source: "heuristic", note: `heuristic matched a single count of ${count}` };
    }
    if (found.size > 1) {
      return {
        count: null,
        source: "unresolved",
        note: `heuristic found conflicting counts (${[...found].join(", ")})`,
      };
    }
  }

  // 3. Unresolved.
  return {
    count: null,
    source: "unresolved",
    note: rules.length ? "no shop rule matched any variation" : "no shop rule configured",
  };
}

function applyRule(rule: FigureRule, rawValue: string): number | null {
  const value = rawValue?.trim() ?? "";
  if (rule.type === "map") {
    const hit = rule.map?.[value.toLowerCase()];
    return typeof hit === "number" ? hit : null;
  }
  // type "integer": first integer in the value.
  const m = value.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Distinct counts inferred from variation values (heuristic only). */
function heuristicCounts(variations: NormalizedVariation[]): Set<number> {
  const counts = new Set<number>();
  for (const v of variations) {
    const value = v.value ?? "";
    const digitMatch = value.match(new RegExp(`(\\d+)\\s*${SUBJECT_NOUN.source}`, "i"));
    if (digitMatch) counts.add(parseInt(digitMatch[1], 10));
    const wordMatch = value.match(
      new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b\\s*${SUBJECT_NOUN.source}`, "i"),
    );
    if (wordMatch) counts.add(NUMBER_WORDS[wordMatch[1].toLowerCase()]);
  }
  counts.delete(0);
  return counts;
}
