export type ReplyIntent = "approval" | "revision_request" | "question" | "unclear";

export type ReplyClassification = {
  intent: ReplyIntent;
  confidence: number;
  rationale: string;
  strippedText: string;
  model: string;
};

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const REQUEST_TIMEOUT_MS = 4_500;

export function stripQuotedReplyText(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const cutPatterns = [
    /^>/,
    /^On .+wrote:$/i,
    /^On .+ at .+ wrote:$/i,
    /^From:\s.+$/i,
    /^Sent:\s.+$/i,
    /^To:\s.+$/i,
    /^Subject:\s.+$/i,
    /^-{2,}\s*Original Message\s*-{2,}$/i,
    /^_{5,}$/,
    /gmail_quote/i,
  ];
  const kept: string[] = [];
  for (const line of normalized.split("\n")) {
    if (cutPatterns.some((pattern) => pattern.test(line.trim()))) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export async function classifyProofReply(input: {
  subject: string | null;
  body: string;
}): Promise<ReplyClassification | null> {
  const strippedText = stripQuotedReplyText(input.body);
  if (!strippedText) {
    return {
      intent: "unclear",
      confidence: 0,
      rationale: "No new reply text remained after quoted email content was removed.",
      strippedText: "",
      model: "quote-stripper",
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 160,
        messages: [
          {
            role: "user",
            content: buildPrompt({ subject: input.subject, strippedText }),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: { type?: string; text?: string }[] };
    const text = json.content?.find((part) => part.type === "text")?.text?.trim();
    if (!text) return null;
    const parsed = parseClassification(text);
    if (!parsed) return null;
    return { ...parsed, strippedText, model };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(input: { subject: string | null; strippedText: string }): string {
  return [
    "Classify this customer reply to a portrait proof email.",
    "Use only the new reply text below. Quoted prior email has already been removed.",
    "Return strict JSON only, with keys: intent, confidence, rationale.",
    "intent must be one of: approval, revision_request, question, unclear.",
    "approval means the customer clearly approves the portrait/proof and wants to proceed/ship/print.",
    "revision_request means the customer asks for any visual change or correction.",
    "question means they ask a question without clearly approving or requesting changes.",
    "unclear means ambiguous, mixed, empty, or not enough information.",
    "confidence is a number from 0 to 1.",
    "Keep rationale under 140 characters.",
    "",
    `Subject: ${input.subject ?? ""}`,
    "Reply:",
    input.strippedText,
  ].join("\n");
}

function parseClassification(text: string): Omit<ReplyClassification, "strippedText" | "model"> | null {
  const raw = extractJson(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { intent?: unknown; confidence?: unknown; rationale?: unknown };
    if (
      parsed.intent !== "approval" &&
      parsed.intent !== "revision_request" &&
      parsed.intent !== "question" &&
      parsed.intent !== "unclear"
    ) {
      return null;
    }
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence);
    return {
      intent: parsed.intent,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 240) : "",
    };
  } catch {
    return null;
  }
}

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0] ?? null;
}
