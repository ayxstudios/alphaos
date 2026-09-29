/** The drawing recipes the AI designer can use. Add a line here when a new flow is approved. */
export const AI_FRAMEWORKS = [{ key: "pixart-disney-pet", label: "PixArt Disney pet (CSS flow)" }] as const;

export const DEFAULT_AI_FRAMEWORK = AI_FRAMEWORKS[0].key;

export function aiFrameworkLabel(key: string | null | undefined): string {
  return AI_FRAMEWORKS.find((f) => f.key === key)?.label ?? key ?? "";
}

const AI_STATE_LABELS: Record<string, string> = {
  queued: "waiting its turn",
  claimed: "drawing now",
  revision: "revision queued",
  revision_claimed: "redrawing now",
  qc: "checking itself",
  owner_review: "waiting for your approval",
  with_buyer: "with the buyer",
  failed: "needs a human",
};

/** Plain words for orders.ai_state. */
export function aiStateLabel(state: string): string {
  return AI_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}
