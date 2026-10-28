// The agent's first draft of an answer to a buyer question (agent-first phase
// 2). One short completion through lib/ai/complete.ts. The result is only ever
// a DRAFT in the VA outbox, so the prompt keeps it honest: answer what the shop
// can say for sure, and say anything that needs a person (price, size or product
// changes, dates) will be confirmed. It is written as the shop's one person, who
// is also the artist (Yousif 2026-10-28): "I", never "the team" or "our artist".
// Returns null when no model answers.
import { completeText } from "@/lib/ai/complete";
import { signOffFor } from "@/lib/email/template-meta";

const MAX_ANSWER_CHARS = 2000;

export type AnswerDraftInput = {
  businessName: string;
  firstName: string | null;
  orderNumber: string;
  /** Plain words, e.g. "waiting for the customer to approve the proof". */
  orderStage: string;
  question: string;
  /** The exact closing lines (agentConfig.replySignOff); default the shop's persona (signOffFor). */
  signOff?: string | null;
  /**
   * The buyer's orders block (lib/orders/same-buyer.ts buyerOrdersPromptBlock):
   * this order's product line, their other orders and the rule not to answer
   * about one order with another's status, file or proof. Absent when the buyer
   * has only this order, and the prompt is then unchanged.
   */
  buyerOrders?: string | null;
};

export async function draftAnswerToQuestion(input: AnswerDraftInput): Promise<string | null> {
  const prompt = [
    "Draft a reply to this customer question about their custom portrait order.",
    `You write for ${input.businessName}, a small custom portrait shop. A staff member reviews the draft before it is sent.`,
    "Write as the shop's one person, in the first person (I, me, my), the same person who draws the portraits: never",
    "\"the team\", \"our team\", \"our artist\", \"your artist\" or \"one of our artists\".",
    "Rules: 2 to 5 short sentences, warm and plain. Do not promise prices, refunds, size or product changes, or dates;",
    "for anything like that say you will confirm it. No em dashes. No placeholders. Output only the email body.",
    `Open with "Hi ${input.firstName ?? "there"}," on its own line, and end with exactly these closing lines:`,
    signOffFor({ name: input.businessName, replySignOff: input.signOff }),
    `Customer first name: ${input.firstName ?? "there"}`,
    `Order: ${input.orderNumber} (${input.orderStage})`,
    ...(input.buyerOrders ? [input.buyerOrders] : []),
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
