// Photo completeness for the agent (docs/AGENT_FIRST.md). Pure: no db. A guess
// never raises an exception: any item whose figure count is missing or not from
// a trusted source makes the verdict "unknown".

export type CompletenessItem = {
  figureCount: number | null;
  figureCountSource: string | null;
};

export type CompletenessInput = {
  photoCount: number;
  items: CompletenessItem[];
};

export type CompletenessResult = {
  verdict: "ok" | "mismatch" | "unknown";
  expectedFigures: number | null;
  photoCount: number;
};

// Sources set by a rule or a person; "heuristic" is a guess, "unresolved" is none.
const TRUSTED_SOURCES = new Set(["shop_rule", "manual"]);

export function computeCompleteness(input: CompletenessInput): CompletenessResult {
  const { photoCount, items } = input;
  let expected = 0;
  for (const item of items) {
    if (
      item.figureCount === null ||
      item.figureCountSource === null ||
      !TRUSTED_SOURCES.has(item.figureCountSource)
    ) {
      return { verdict: "unknown", expectedFigures: null, photoCount };
    }
    expected += item.figureCount;
  }
  // Extra photos are fine; only fewer than the figures ordered is a mismatch.
  return {
    verdict: photoCount >= expected ? "ok" : "mismatch",
    expectedFigures: expected,
    photoCount,
  };
}
