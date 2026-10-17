// Her words asking for money back (Yousif 2026-10-17 12:50, every shop: "For customers wanting a refund. Don't message
// them until you check with me and we investigate what happened. Don't say "I'll check with the owner or anything at
// all" say nothing until we confirm"). The same patterns as the agent's lib/refund-hold.js, so the inbox and the agent
// agree on what a money-back ask is: a refund, her money back, a chargeback or dispute, cancelling what she paid for.
// Words that only name it ("I don't want a refund, just a fix", "no need to cancel") are not an ask.

const MONEY_BACK: RegExp[] = [
  /\brefund\w*/i,
  /\b(?:my|the|our|her|his|your)\s+(?:money|payment|cash)\s+back\b|\b(?:money|payment|cash)\s+back\b/i,
  /\breimburs\w*/i,
  /\bcharge\s?-?backs?\b/i,
  /\b(?:open|file|raise|start|lodge)\w*\s+(?:a\s+)?(?:dispute|claim)\b|\bdispute\s+(?:it|this|the\s+(?:charge|payment|transaction))\b|\b(?:my\s+)?(?:bank|paypal|card\s+company)\b[^.?!\n]{0,40}\b(?:dispute|claim|reverse|chargeback)/i,
  /\bcancel\w*\s+(?:my\s+|the\s+|this\s+|our\s+|her\s+|his\s+)?(?:whole\s+|entire\s+)?(?:order|purchase|payment|transaction|print)s?\b/i,
  /\b(?:want|like|need|wish|going|have|has|had|asked|asking|trying|please)\s+(?:to\s+)?cancel\b(?!\s+(?:the\s+|my\s+|that\s+|this\s+)?(?:revision|change|edit|request|note|message|reprint|update|address)s?\b)/i,
  /\bcancel(?:lation)?\s+(?:it|everything|please)\b|\bplease\s+cancel\b|\b(?:request|asked for|want|need)\s+(?:a\s+)?cancellation\b/i,
];

const NOT_ASKING = new RegExp(
  [
    String.raw`(?:\bno|\bnot|n['’]t|\bnever|\bwithout|\bdo not)\s+(?:even\s+)?(?:(?:(?:want|need|ask|look|expect|request|seek|requir)\w*|after|interested\s+in)\s+(?:for\s+|to\s+)?)?(?:a\s+|any\s+|my\s+|the\s+|your\s+)?(?:refund\w*|money\s+back|reimburs\w*|cancel\w*)`,
    String.raw`\bno\s+need\s+(?:for|to)\s+(?:a\s+|any\s+)?(?:refund\w*|cancel\w*)`,
    String.raw`\bno\s+(?:refund|cancellation)s?\s+(?:is\s+|are\s+)?(?:needed|necessary|required|wanted)`,
    String.raw`\b(?:instead\s+of|rather\s+than)\s+(?:a\s+)?(?:refund\w*|cancel\w*|money\s+back)`,
  ].join("|"),
  "gi",
);

/** The words of hers that ask for money back (a short quote), or null. */
export function moneyBackAsk(words: string | null | undefined): string | null {
  const t = String(words || "").replace(NOT_ASKING, " ");
  for (const re of MONEY_BACK) {
    const m = t.match(re);
    if (m) return m[0].replace(/\s+/g, " ").trim().slice(0, 60);
  }
  return null;
}
