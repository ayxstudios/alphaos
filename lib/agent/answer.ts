// The agent's first draft of an answer to a buyer question (agent-first phase
// 2). One short completion through lib/ai/complete.ts. The result is only ever
// a DRAFT in the VA outbox, so the prompt keeps it honest: answer what the shop
// can say for sure, and say the team will confirm anything that needs a person
// (price, size or product changes, dates). Returns null when no model answers.
import { completeText } from "@/lib/ai/complete";

const MAX_ANSWER_CHARS = 2000;

export type AnswerDraftInput = {
  businessName: string;
  firstName: string | null;
  orderNumber: string;
  /** Plain words, e.g. "waiting for the customer to approve the proof". */
  orderStage: string;
  question: string;
};

export async function draftAnswerToQuestion(input: AnswerDraftInput): Promise<string | null> {
  const prompt = [
    "Draft a reply to this customer question about their custom portrait order.",
    `You write for ${input.businessName}, a small custom portrait shop. A staff member reviews the draft before it is sent.`,
    "Rules: 2 to 5 short sentences, warm and plain. Do not promise prices, refunds, size or product changes, or dates;",
    "for anything like that say the team will check and confirm. No em dashes. No placeholders. Output only the email body.",
    `Customer first name: ${input.firstName ?? "there"}`,
    `Order: ${input.orderNumber} (${input.orderStage})`,
    `Question: ${input.question}`,
  ].join("\n");
  const completion = await completeText(prompt, {
    maxTokens: 400,
    timeoutMs: 15_000,
    relayTimeoutMs: 30_000,
    kind: "draft-answer",
  });
  const text = completion?.text.trim().replace(/—/g, ", ");
  if (!text) return null;
  return text.length > MAX_ANSWER_CHARS ? null : text;
}
