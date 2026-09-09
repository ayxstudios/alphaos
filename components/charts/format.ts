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

export function fmtInt(n: number): string {
  return new Intl.NumberFormat("en-AU").format(Math.round(n));
}

export function fmtMoney(n: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);
}
