/**
 * Figure count typed on the manual order form (create and complete details).
 *
 * Security QA round 2 (P2): any positive number was stored, so 1,000,000 or
 * 2,147,483,647 figures landed on the order item (designer pay is per figure),
 * and 1e10 overflowed the integer column and sent the raw SQL error back to the
 * browser. The largest real portrait is far below MAX_FIGURES.
 *
 * Unchanged from before: blank, zero, negative or non-numbers mean "not set"
 * (null), fractions round down.
 */
export const MAX_FIGURES = 50;

export type FigureCountResult = { ok: true; value: number | null } | { ok: false; message: string };

export function parseFigureCount(raw: unknown): FigureCountResult {
  if (typeof raw !== "number" || Number.isNaN(raw) || raw <= 0) return { ok: true, value: null };
  const value = Math.floor(raw);
  if (!Number.isFinite(raw) || value > MAX_FIGURES) {
    return { ok: false, message: `Figures must be between 1 and ${MAX_FIGURES}.` };
  }
  return { ok: true, value: value < 1 ? null : value };
}
