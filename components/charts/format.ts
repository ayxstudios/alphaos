// Plain helpers, safe on the server and the client (no "use client").
export function niceMax(max: number): number {
  if (max <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = [1, 2, 2.5, 4, 5, 10];
  for (const s of steps) {
    const v = s * pow;
    if (v >= max) return v;
  }
  return 10 * pow;
}

/**
 * niceMax for whole-number counts: the half-way gridline is a whole number
 * too, so a count axis never reads "0, 3, 5" (2.5 rounded up).
 */
export function niceMaxInt(max: number): number {
  if (max <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const steps = pow === 1 ? [2, 4, 6, 8, 10] : [2, 3, 4, 5, 6, 8, 10];
  for (const s of steps) {
    const v = s * pow;
    if (v >= max) return v;
  }
  return 10 * pow;
}

export function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-AU").format(Math.round(n));
}

export function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);
}
