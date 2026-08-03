import {
  resolveFigureCount as resolveShared,
  resolveStyle as resolveStyleShared,
  type FigureConfig,
  type FigureResolution,
  type StyleResolution,
  type NormalizedVariation,
} from "../figures";

export type { FigureResolution, StyleResolution };

/**
 * Adapter: Shopify variant options / line-item properties are already
 * normalized to {name, value} by the order mapper, so this just delegates.
 */
export function resolveFigureCount(
  options: NormalizedVariation[],
  config: FigureConfig | null | undefined,
): FigureResolution {
  return resolveShared(options ?? [], config);
}

export function resolveStyle(
  options: NormalizedVariation[],
  config: FigureConfig | null | undefined,
): StyleResolution {
  return resolveStyleShared(options ?? [], config);
}
