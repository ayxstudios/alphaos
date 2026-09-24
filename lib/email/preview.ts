/**
 * The short preview a mail list row shows (the Messages page clamps a row to
 * three lines). The full body stays on the server and is loaded on expand:
 * 50 history rows used to ship ~63 KB of body text nobody could see.
 */

export const MAIL_PREVIEW_CHARS = 300;

// Where quoted history begins in a plain-text reply: "On <date>, <name>
// wrote:" (the name may wrap onto the next line), a forwarded header, or an
// Outlook-style original-message rule. Also a first quoted ("> ") line.
const QUOTE_STARTS: RegExp[] = [
  /^On [^\n]{0,300}?(?:\n[^\n]{0,300}?)?wrote:[ \t]*$/m,
  /^From:/m,
  /^-----\s*Original/m,
  /^>/m,
];

/** Plain text before any quoted history, whitespace tidied. */
export function stripQuotedHistory(body: string): string {
  let text = body.replace(/\r\n?/g, "\n");
  let cut = text.length;
  for (const re of QUOTE_STARTS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  text = text.slice(0, cut);
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** First ~N characters of the unquoted text, cut on a word, with an ellipsis when shortened. */
export function mailPreview(body: string | null | undefined, max = MAIL_PREVIEW_CHARS): { preview: string; hasMore: boolean } {
  const full = (body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!full) return { preview: "", hasMore: false };
  const text = stripQuotedHistory(full);
  if (text.length <= max) return { preview: text, hasMore: text.length < full.length };
  let head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  if (space > max * 0.6) head = head.slice(0, space);
  return { preview: `${head.trimEnd()}…`, hasMore: true };
}
