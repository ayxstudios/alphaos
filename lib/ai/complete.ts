// One text completion for AlphaOS's small AI jobs (reply classification, the
// daily health narrative). Two roads, in this order:
//   1. ANTHROPIC_API_KEY set: the Anthropic Messages API directly (fast).
//   2. Otherwise the Alpha relay (ALPHA_HOOK_URL + ALPHA_HOOK_SECRET): the
//      daemon behind the chat widget runs the prompt as one turn and hands
//      the text back. Slower (10 to 20 s through the tunnel), so the relay
//      gets its own, longer timeout.
// Returns null when no road answers; callers keep their own fallback.
import { completeViaAlpha } from "@/lib/alpha/client";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";

export type CompleteOptions = {
  maxTokens: number;
  /** Timeout for the direct Anthropic road. */
  timeoutMs: number;
  /** Timeout for the relay road (default 25 s). */
  relayTimeoutMs?: number;
  /** Short label for the relay's page field (telemetry only). */
  kind?: string;
};

export type Completion = { text: string; model: string };

export function directAnthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

async function completeDirect(prompt: string, opts: CompleteOptions): Promise<Completion | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = json.content?.find((part) => part.type === "text")?.text?.trim();
    return text ? { text, model } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function completeText(prompt: string, opts: CompleteOptions): Promise<Completion | null> {
  if (directAnthropicConfigured()) return completeDirect(prompt, opts);
  const text = await completeViaAlpha(prompt, { timeoutMs: opts.relayTimeoutMs ?? 25000, kind: opts.kind });
  return text ? { text, model: "alpha-relay" } : null;
}
