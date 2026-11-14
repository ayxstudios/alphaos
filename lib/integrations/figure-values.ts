/**
 * Reading a figure count out of option NAMES and VALUES the way a person would.
 * Pure: no database, no network, so scripts/test-figure-values.ts pins every
 * rule. figure_count drives designer pay, so each function answers null the
 * moment a value is not clearly one thing ("never guess; wrong is worse than
 * unknown"). Null is cheap: a digital order still completes and its earning
 * waits blocked with "Missing figure count." until the count is known.
 *
 * Why it exists: Perfetta house, venue and car listings name the option
 * "Options" or "Drawing Options" and put the subject in the value ("House (With
 * Yard)", "House & 4 Figure/pet", "Venue +2 people/pets", "Car Only"), and the
 * Etsy count labels come in more spellings than a fixed list ("Number Of
 * People/Pets"). The shop rules only knew the exact names, so those orders
 * stayed unresolved and (before digital orders were exempt) never closed.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** A drawn subject that is one figure by itself ("House Only", "Car Only"). */
const SUBJECT_NOUN = /^(?:house|houses|home|homes|venue|venues|car|cars|vehicle|vehicles|church|churches|building|buildings)$/;
/** A person or pet added on top of the subject ("+2 people/pets"). */
const FIGURE_NOUN = /^(?:figure|figures|person|persons|people|pet|pets|dog|dogs|cat|cats|character|characters|face|faces|kid|kids|child|children|subject|subjects)$/;
/** Words that may sit between a number and the noun it counts ("2 more pets", "3 x people"). */
const COUNT_FILLER = new Set(["more", "extra", "additional", "x", "add", "added", "other"]);

/** The most figures one portrait line can carry (same ceiling inferItemFigureCount enforces). */
const MAX_COUNT = 20;

/** Lower-case words of a label or value with punctuation turned into single spaces. */
function wordsOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numberOf(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return parseInt(token, 10);
  return NUMBER_WORDS[token] ?? null;
}

export type SubjectLedCount = {
  /** Subjects plus added figures: the figure count. */
  count: number;
  /** House, venue, car... (each one figure by itself). */
  subjects: number;
  /** People and pets named on top of the subject. */
  added: number;
};

/**
 * "House & 4 Figure/pet" -> 5, "House (With Yard)" -> 1, "Venue +2 people/pets"
 * -> 3, "Car Only" -> 1, "2 Houses" -> 2. The value must name at least one
 * subject (house, home, venue, car, vehicle, church, building); a figure noun
 * with no number ("House + pets"), a number that counts nothing we know
 * ("House 2", "8x10") or no subject at all ("Add Background") is null.
 */
export function parseSubjectLed(value: string | null | undefined): SubjectLedCount | null {
  if (!value) return null;
  const cleaned = value
    .toLowerCase()
    .replace(/&amp;/g, "&")
    // Price fragments are not counts: "(+$20.00)", "+ A$5", "12 AUD".
    .replace(/[+-]?\s*(?:a\$|us\$|[$€£])\s*\d[\d.,]*/g, " ")
    .replace(/\b\d[\d.,]*\s*(?:aud|usd|eur|gbp|nzd|cad)\b/g, " ");
  const tokens = cleaned.match(/\d+|[a-z]+|[+&/]/g);
  if (!tokens) return null;

  let subjects = 0;
  let added = 0;
  // "figure/pet", "people or pets", "home/house": alternates for ONE thing, counted once.
  const skipAlternates = (from: number, pattern: RegExp): number => {
    let at = from;
    while (at + 2 < tokens.length && (tokens[at + 1] === "/" || tokens[at + 1] === "or") && pattern.test(tokens[at + 2])) at += 2;
    return at;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d+$/.test(token)) {
      const n = numberOf(token);
      // A long number (a year, a street number) is wording, not a count.
      if (n == null && token.length > 2) continue;
      if (n == null || n < 1) return null;
      let j = i + 1;
      while (j < tokens.length && COUNT_FILLER.has(tokens[j])) j++;
      const noun = tokens[j];
      if (noun && SUBJECT_NOUN.test(noun)) {
        subjects += n;
        i = skipAlternates(j, SUBJECT_NOUN);
        continue;
      }
      if (noun && FIGURE_NOUN.test(noun)) {
        added += n;
        i = skipAlternates(j, FIGURE_NOUN);
        continue;
      }
      return null; // a number counting something we do not know
    }
    const word = NUMBER_WORDS[token];
    if (word != null) {
      let j = i + 1;
      while (j < tokens.length && COUNT_FILLER.has(tokens[j])) j++;
      const noun = tokens[j];
      if (noun && SUBJECT_NOUN.test(noun)) {
        subjects += word;
        i = skipAlternates(j, SUBJECT_NOUN);
        continue;
      }
      if (noun && FIGURE_NOUN.test(noun)) {
        added += word;
        i = skipAlternates(j, FIGURE_NOUN);
        continue;
      }
      continue; // "one" in "one of a kind" is just a word
    }
    if (SUBJECT_NOUN.test(token)) {
      subjects += 1;
      i = skipAlternates(i, SUBJECT_NOUN);
      continue;
    }
    if (FIGURE_NOUN.test(token)) return null; // figures with no number
  }

  if (subjects < 1) return null;
  const count = subjects + added;
  if (count < 1 || count > MAX_COUNT) return null;
  return { count, subjects, added };
}

/** The count alone; see {@link parseSubjectLed}. */
export function parseSubjectLedCount(value: string | null | undefined): number | null {
  return parseSubjectLed(value)?.count ?? null;
}

/** Whether a value talks about a drawn subject or figures at all (even if unreadably). */
export function mentionsFigureWords(value: string | null | undefined): boolean {
  if (!value) return false;
  return wordsOf(value)
    .split(" ")
    .some((w) => SUBJECT_NOUN.test(w) || FIGURE_NOUN.test(w) || w === "couple" || w === "couples" || w === "family");
}

/**
 * The value of an option whose NAME already says it is a count ("Number Of
 * People/Pets", "No. of characters"). Subject-led reading first ("Venue +2
 * people/pets" -> 3), then the first integer or spelled-out number ("2
 * Figures+Background" -> 2). "Add Background" and "House + pets" are null.
 */
export function parseCountOptionValue(value: string | null | undefined): number | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  const led = parseSubjectLed(text);
  if (led) return led.count;
  // A subject word the strict reading refused is ambiguous: do not fall back to a stray digit.
  if (wordsOf(text).split(" ").some((w) => SUBJECT_NOUN.test(w))) return null;
  const digits = text.match(/\d+/);
  if (digits) {
    const n = parseInt(digits[0], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const word = text.toLowerCase().match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
  return word ? NUMBER_WORDS[word[1]] : null;
}

// Option names that are about something else, never about how many figures.
const NOT_A_COUNT_NAME =
  /\b(?:background|size|sizes|print|printed|frame|framed|paper|canvas|rush|personali[sz]ation|personali[sz]ed|colou?rs?|font|fonts|shipping|delivery|turnaround|gift|message|note|text|wording|engraving|material|finish|licen[sc]e)\b/;
const COUNT_LEAD = /\b(?:number of|no of|num of|how many|count of)\b/;
const COUNT_NOUN = /\b(?:people|persons?|pets?|figures?|characters?|subjects?|faces?)\b/;
const SUBJECT_OPTION_NAME = /\b(?:options?|drawing|characters?|figures?|people|persons?|pets?|type|subjects?)\b/;

/**
 * Whether an option name asks for a count: "Number Of People/Pets", "Number Of
 * Figures/Pets", "No. of characters (houses, people, pets, etc)", "How many
 * pets?", or just "Figures". Case and punctuation are ignored.
 */
export function isFigureCountLabel(name: string | null | undefined): boolean {
  if (!name) return false;
  const words = wordsOf(name);
  if (!words || NOT_A_COUNT_NAME.test(words)) return false;
  if (words === "figures" || words === "figure" || words === "figure count") return true;
  return COUNT_LEAD.test(words) && COUNT_NOUN.test(words);
}

/**
 * Whether an option name may carry the subject in its VALUE ("Options",
 * "Drawing Options", "Characters", "Type"). Background, size, print, frame,
 * paper, rush, personalization, colour and font options never do.
 */
export function isSubjectOptionName(name: string | null | undefined): boolean {
  if (!name) return false;
  const words = wordsOf(name);
  return !!words && SUBJECT_OPTION_NAME.test(words) && !NOT_A_COUNT_NAME.test(words);
}

export type VariationPair = { name: string; value: string };

export type VariationReading =
  | {
      status: "count";
      count: number;
      /** Stated figure numbers that agree with this reading (the buyer's own words). */
      agrees: number[];
      note: string;
    }
  | { status: "ambiguous"; note: string }
  | { status: "none" };

/**
 * Read a count from an item's options. "count" = one clear answer; "ambiguous"
 * = something looks like a count but cannot be read, or two readings disagree
 * (the caller must not guess a default over it); "none" = nothing in the
 * options talks about a count at all.
 */
export function readCountFromVariations(variations: VariationPair[]): VariationReading {
  const counts: { count: number; agrees: number[]; note: string }[] = [];
  let ambiguous: string | null = null;
  for (const v of variations) {
    const label = isFigureCountLabel(v.name);
    const subjectName = !label && isSubjectOptionName(v.name);
    if (!label && !subjectName) continue;
    const led = parseSubjectLed(v.value);
    if (led) {
      counts.push({
        count: led.count,
        // The buyer counting only the extras ("2 dogs" on "Venue +2 people/pets") agrees; any
        // other stated number, or any stated number on a subject-only option, is a contradiction.
        agrees: led.added > 0 ? [led.added] : [],
        note: `option "${v.name}: ${v.value}" names ${led.subjects} subject${led.subjects === 1 ? "" : "s"}${led.added ? ` plus ${led.added} added` : ""}`,
      });
      continue;
    }
    if (label) {
      const n = parseCountOptionValue(v.value);
      if (n != null && n <= MAX_COUNT) {
        counts.push({ count: n, agrees: [n], note: `option "${v.name}: ${v.value}"` });
      } else {
        ambiguous = `option "${v.name}: ${v.value}" is not a readable count`;
      }
      continue;
    }
    if (mentionsFigureWords(v.value)) ambiguous = `option "${v.name}: ${v.value}" mentions figures but is not a readable count`;
  }
  const distinct = [...new Set(counts.map((c) => c.count))];
  if (distinct.length > 1) return { status: "ambiguous", note: `options disagree (${distinct.join(", ")})` };
  if (ambiguous) return { status: "ambiguous", note: ambiguous };
  if (counts.length) return { status: "count", count: counts[0].count, agrees: counts[0].agrees, note: counts[0].note };
  return { status: "none" };
}

const TITLE_FORMAT = "(?:portrait|drawing|sketch|painting|illustration|artwork)s?";
const TITLE_SUBJECT = "(?:house|home|venue|car|vehicle)s?";
const SINGLE_SUBJECT_TITLE = new RegExp(
  `\\b${TITLE_SUBJECT}[\\s-]+${TITLE_FORMAT}\\b|\\b${TITLE_FORMAT}\\s+of\\s+(?:your|a|the|my|our)?\\s*${TITLE_SUBJECT}\\b`,
);
const PEOPLE_OR_PET_WORDS =
  /\b(?:people|persons?|pets?|dogs?|cats?|puppy|puppies|kittens?|family|families|couples?|figures?|kids?|child|children|friends?|siblings?|brides?|grooms?|newlyweds?|husband|wife|baby|babies|horses?|animals?)\b/;

/** Whether a title or option value mentions people or pets (whole words), so a house guess must not stand. */
export function mentionsPeopleOrPets(text: string | null | undefined): boolean {
  return !!text && PEOPLE_OR_PET_WORDS.test(text.toLowerCase());
}

// Buyer free text (personalization, note to the seller) is wider than a title:
// "gift for my mum" and "The Owen Family Home" are everyday house-portrait wording
// that says nothing about extra figures, so only people and pet NOUNS count here.
const FIGURES_IN_NOTE =
  /\b(?:people|persons?|pets?|dogs?|cats?|puppy|puppies|kittens?|figures?|characters?|couple|kids?|children|bride|groom)\b/;

/** Whether buyer free text names people or pets, so a house or car guess must not stand. */
export function mentionsFiguresInNote(text: string | null | undefined): boolean {
  return !!text && FIGURES_IN_NOTE.test(text.toLowerCase());
}

/**
 * A listing whose title names ONE drawn subject and nobody else ("Minimalist
 * Watercolour Sketch of Your Home", "Custom Watercolor House Portrait",
 * "Personalized Car Drawing from Photo") is one figure. A title that also
 * mentions people, pets, a family or a couple is not.
 */
export function titleNamesSingleSubject(title: string | null | undefined): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  return SINGLE_SUBJECT_TITLE.test(lower) && !PEOPLE_OR_PET_WORDS.test(lower);
}
