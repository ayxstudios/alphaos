import { alphaConnected } from "@/lib/alpha/client";

/**
 * AI-backed features (reply suggestions, the daily health narrative) show
 * when the app can reach a model: its own ANTHROPIC_API_KEY, or the Alpha
 * relay (ALPHA_HOOK_URL + ALPHA_HOOK_SECRET, see lib/ai/complete.ts).
 */
export function anthropicFeaturesEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim()) || alphaConnected();
}
