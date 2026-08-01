import {
  resolveFigureCount as resolveShared,
  type FigureConfig,
  type FigureResolution,
  type NormalizedVariation,
} from "../figures";

export type { FigureResolution };

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
