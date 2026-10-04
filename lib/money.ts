/**
 * Designer pay is in US dollars, everywhere: one formatter so every screen,
 * the CSV and the invoice say the same thing ("$5.00").
 */
export const USD_LABEL = "USD";

/** Flat pay for one figure, in USD. A style's own per_figure_rate overrides it. */
export const PER_FIGURE_RATE_USD = 5.0;

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
