/**
 * [2] -> "Portrait 2"; [2, 3] -> "Portraits 2 and 3"; [1, 2, 5] -> "Portraits
 * 1, 2 and 5". No database imports, so client components use it too.
 */
export function portraitList(ns: number[]): string {
  if (ns.length === 1) return `Portrait ${ns[0]}`;
  return `Portraits ${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
}
