/**
 * Designer pay is in US dollars, everywhere: one formatter so every screen,
 * the CSV and the invoice say the same thing ("$5.00").
 */
export const USD_LABEL = "USD";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 5 -> "$5.00", "12.5" -> "$12.50". */
export function formatUsd(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return usd.format(Number.isFinite(n) ? n : 0);
}

/** 5 -> "$5.00/fig". */
export function formatUsdPerFigure(value: number | string): string {
  return `${formatUsd(value)}/fig`;
}
