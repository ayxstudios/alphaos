const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
// "3 dogs", "two people", "4 kids" written by the buyer in free text.
const TEXT_COUNT =
  /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[a-z]+\s+)?(pets?|dogs?|cats?|people|persons?|figures?|kids?|children|faces?|characters?|subjects?|family members?)\b/gi;

/** Counts the buyer states in their own words (personalisation, note to seller). */
export function countsInText(text: string | null | undefined): number[] {
  if (!text) return [];
  const out: number[] = [];
  for (const m of text.matchAll(TEXT_COUNT)) {
    const raw = m[1].toLowerCase();
    const n = NUMBER_WORDS[raw] ?? parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}
