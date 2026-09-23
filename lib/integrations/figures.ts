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
  /**
   * Substring matched against the variation's name. Case-insensitive and
   * tolerant of trailing punctuation on either side, so a rule "Number of Pets"
   * matches an option literally named "Number of Pets:".
   */
  match: string;
  /** How to derive the count from the variation's value. */
  type: "integer" | "map";
  /** For type "map": exact value (lowercased) -> count. */
  map?: Record<string, number>;
};

/**
 * A single style rule (shops.integration_config.styleRules[]). The matched
 * option's VALUE becomes the style (optionally remapped). Naming varies per shop
 * ("Style", "Print On:", "Design"…), so it is configured, never hardcoded.
 */
export type StyleRule = {
  /** Substring matched against the variation's name (same matching as FigureRule). */
  match: string;
  /** Optional exact value (lowercased) -> canonical style; unmapped values pass through. */
  map?: Record<string, string>;
};

/**
 * A product-title -> style rule (shops.integration_config.titleStyleRules[]).
 * Use this when the style is baked into the LISTING itself (e.g. an Etsy shop
 * with a "Watercolor Pet Portrait" listing) rather than chosen as an option.
 */
export type TitleStyleRule = {
  /** Substring matched against the product title (case-insensitive, punctuation-tolerant). */
  match: string;
  /** The style assigned when the title matches. */
  style: string;
};

/** The resolution slice of a shop's integration config. */
export type FigureConfig = {
  figureRules?: FigureRule[];
  styleRules?: StyleRule[];
  /** Style by product title, for shops that sell one style per listing. */
  titleStyleRules?: TitleStyleRule[];
  /** Shop-wide fallback style (e.g. a shop that is entirely one style). */
  defaultStyle?: string;
  allowHeuristicFigureCount?: boolean; // default false
};

/**
 * Normalise a name for matching: lowercase, trim, and strip surrounding
 * punctuation/whitespace so "Number of Pets:" and "number of pets" compare equal.
 */
function normalizeName(s: string): string {
  return s.toLowerCase().trim().replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
}

/** Whether a variation name matches a rule's match string (tolerant substring). */
function nameMatches(variationName: string | undefined, match: string): boolean {
  if (!variationName) return false;
  return normalizeName(variationName).includes(normalizeName(match));
}

/**
 * Case-insensitive, punctuation-tolerant substring match — reused by the
 * non-portrait classifier for product titles.
 */
export function matchesTolerant(text: string | null | undefined, needle: string): boolean {
  return nameMatches(text ?? undefined, needle);
}

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

/**
 * Built-in figure rules for the option names virtually every portrait shop uses
 * ("Number of Pets: 1", "How many people", …). These are explicit name -> integer
 * mappings, not guesses, so a clearly-stated count resolves WITHOUT each shop
 * having to configure a rule. Per-shop `figureRules` always run first and win;
 * these only fill the gap when no shop rule claimed the item. A shop can still
 * override any of these by configuring its own rule for the same option.
 */
const DEFAULT_FIGURE_RULES: FigureRule[] = [
  { match: "number of pets", type: "integer" },
  { match: "number of people", type: "integer" },
  { match: "number of persons", type: "integer" },
  { match: "number of subjects", type: "integer" },
  { match: "number of figures", type: "integer" },
  { match: "number of portraits", type: "integer" },
  { match: "number of faces", type: "integer" },
  { match: "number of characters", type: "integer" },
  { match: "how many pets", type: "integer" },
  { match: "how many people", type: "integer" },
];

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
    const v = variations.find((x) => nameMatches(x.name, rule.match));
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

  // 2. Built-in default rules for the universal count options. To honour "never
  //    guess when unsure", these resolve only when they AGREE: one distinct count
  //    across all matching options wins; conflicting counts (e.g. "Number of
  //    Pets: 1" alongside "Number of People: 2") fall through to unresolved.
  const defaultCounts = new Set<number>();
  let matched: NormalizedVariation | undefined;
  for (const rule of DEFAULT_FIGURE_RULES) {
    const v = variations.find((x) => nameMatches(x.name, rule.match));
    if (!v) continue;
    const count = applyRule(rule, v.value);
    if (count != null) {
      if (!defaultCounts.size) matched = v;
      defaultCounts.add(count);
    }
  }
  if (defaultCounts.size === 1 && matched) {
    return {
      count: [...defaultCounts][0],
      source: "shop_rule",
      note: `default rule matched "${matched.name}: ${matched.value}"`,
    };
  }
  if (defaultCounts.size > 1) {
    return {
      count: null,
      source: "unresolved",
      note: `default rules found conflicting counts (${[...defaultCounts].join(", ")})`,
    };
  }

  // 3. Generic heuristic — opt-in per shop (default off).
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

  // 4. Unresolved.
  return {
    count: null,
    source: "unresolved",
    note: rules.length ? "no shop or default rule matched any variation" : "no matching default or shop rule",
  };
}

function applyRule(rule: FigureRule, rawValue: string): number | null {
  const value = rawValue?.trim() ?? "";
  if (rule.type === "map") {
    const hit = rule.map?.[value.toLowerCase()];
    return typeof hit === "number" ? hit : null;
  }
  // type "integer": first integer in the value...
  const m = value.match(/\d+/);
  if (m) {
    const n = parseInt(m[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  // ...or a spelled-out number ("Two" -> 2), since some shops write the count in words.
  const word = value.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  return word ? NUMBER_WORDS[word[1]] : null;
}

export type StyleResolution = {
  style: string | null;
  source: "shop_rule" | "unresolved";
  note: string;
};

/**
 * Resolve a line item's style from the shop's styleRules (name-matched like
 * figure rules). The first matching option's value becomes the style, remapped
 * through the rule's `map` when present. No rule / no match -> null (the board
 * simply shows no style; unlike figure count, an unknown style is not blocking).
 */
export function resolveStyle(
  variations: NormalizedVariation[],
  config: FigureConfig | null | undefined,
  title?: string | null,
): StyleResolution {
  // 1. A customer-selected style option is the most specific signal.
  for (const rule of config?.styleRules ?? []) {
    const v = variations.find((x) => nameMatches(x.name, rule.match));
    if (!v) continue;
    const raw = v.value?.trim() ?? "";
    if (!raw) continue;
    const mapped = rule.map?.[raw.toLowerCase()];
    const style = mapped ?? raw;
    return { style, source: "shop_rule", note: `style rule "${rule.match}" matched "${v.name}: ${v.value}"` };
  }

  // 2. Style baked into the product title (one style per listing).
  if (title) {
    for (const rule of config?.titleStyleRules ?? []) {
      if (rule.style?.trim() && matchesTolerant(title, rule.match)) {
        return { style: rule.style.trim(), source: "shop_rule", note: `title rule "${rule.match}" matched "${title}"` };
      }
    }
  }

  // 3. A shop that is entirely one style falls back to its default.
  const fallback = config?.defaultStyle?.trim();
  if (fallback) return { style: fallback, source: "shop_rule", note: "shop default style" };

  const configured = (config?.styleRules?.length ?? 0) + (config?.titleStyleRules?.length ?? 0);
  return { style: null, source: "unresolved", note: configured ? "no style rule matched" : "no style rule configured" };
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

/* --- product type (digital vs physical) --------------------------------- */

export type ProductTypeResolution = {
  productType: "digital" | "physical";
  /**
   * option = an option value or the variant title named the format;
   * platform = only the platform flag spoke (Shopify requiresShipping, Etsy
   * is_digital); conflict = the signals disagree and a VA must check.
   */
  source: "option" | "platform" | "conflict";
  conflict: boolean;
  note: string;
};

// Words in an option VALUE that name a digital delivery ("Digital File Only",
// "Instant Download", "Printable PDF"). Option NAMES are never read: PixArt's
// "Need Your Order Within 72 Hours? (For Digital Portraits...)" sits on every
// line, printed or not.
const DIGITAL_VALUE = /\b(digital|downloads?|downloadable|printable|jpe?g|png|pdf)\b/i;
// Words in an option VALUE that name a made, shipped thing.
const PHYSICAL_VALUE =
  /\b(canvas(es)?|framed?|frames|posters?|prints?|printed|mugs?|pillows?|cushions?|blankets?|puzzles?|t-?shirts?|shirts?|tees?|hoodies?|acrylic|metal|ornaments?|stickers?|totes?|keyrings?|keychains?)\b/i;
// Customer-typed free text (names, notes, photos) says nothing about the format:
// "please send the digital file too" must not turn a canvas into a download.
const FREE_TEXT_NAME =
  /(name|note|message|personali[sz]|instruction|request|comment|email|phone|photo|image|upload|wording|dedication|inscription|caption|quote)/i;

/**
 * Decide whether a line item is digital or physical. Pure; shared by the
 * Shopify import, the re-resolve action and the Etsy receipt review.
 *
 * - An option value (or the variant title) naming a digital format wins over
 *   the platform flag: PixArt's "Print On: Digital File Only" variant keeps
 *   Shopify's default requiresShipping = true.
 * - `platformDigital` true (Shopify: the variant requires no shipping; Etsy:
 *   is_digital, a download listing) is digital unless an option says otherwise.
 * - Values naming BOTH a digital and a physical format, or a physical option on
 *   a line the platform calls digital, are a conflict and never guessed: the
 *   platform flag decides the stored type and the order goes to review.
 */
export function resolveProductType(
  variations: NormalizedVariation[],
  platformDigital: boolean,
): ProductTypeResolution {
  let digitalHit: string | null = null;
  let physicalHit: string | null = null;
  for (const v of variations ?? []) {
    if (!v?.value || (v.name && FREE_TEXT_NAME.test(v.name))) continue;
    if (!digitalHit && DIGITAL_VALUE.test(v.value)) digitalHit = `${v.name}: ${v.value}`;
    if (!physicalHit && PHYSICAL_VALUE.test(v.value)) physicalHit = `${v.name}: ${v.value}`;
  }
  const platformType = platformDigital ? ("digital" as const) : ("physical" as const);
  const flag = platformDigital ? "platform: no shipping" : "platform: ships";

  if (digitalHit && physicalHit) {
    return {
      productType: platformType,
      source: "conflict",
      conflict: true,
      note: `options name both a digital and a physical format ("${digitalHit}", "${physicalHit}")`,
    };
  }
  if (digitalHit) {
    return { productType: "digital", source: "option", conflict: false, note: `"${digitalHit}" (${flag})` };
  }
  if (physicalHit && platformDigital) {
    return {
      productType: "digital",
      source: "conflict",
      conflict: true,
      note: `"${physicalHit}" names a physical format but the ${flag}`,
    };
  }
  if (physicalHit) {
    return { productType: "physical", source: "option", conflict: false, note: `"${physicalHit}"` };
  }
  return { productType: platformType, source: "platform", conflict: false, note: flag };
}
