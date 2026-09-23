/**
 * Search box input, made safe to hand to Postgres. A NUL byte ("%00" in the
 * URL) is not valid in a Postgres text parameter and made the query throw
 * (the page rendered its error boundary), and a pasted novel does not need
 * matching: control characters are dropped and the term is capped.
 */
export function cleanSearchTerm(raw: string | null | undefined, max = 200): string {
  if (!raw) return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
}
