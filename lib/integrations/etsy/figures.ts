import {
  resolveFigureCount as resolveShared,
  resolveStyle as resolveStyleShared,
  type FigureResolution,
  type StyleResolution,
} from "../figures";
import type { EtsyVariation, EtsyIntegrationConfig } from "./types";

export type { FigureResolution, StyleResolution };

const toPairs = (variations: EtsyVariation[]) =>
  (variations ?? []).map((v) => ({ name: v.formatted_name, value: v.formatted_value }));

/** Adapter: Etsy variations -> shared resolver. */
export function resolveFigureCount(
  variations: EtsyVariation[],
  config: EtsyIntegrationConfig | null | undefined,
): FigureResolution {
  return resolveShared(toPairs(variations), config);
}

export function resolveStyle(
  variations: EtsyVariation[],
  config: EtsyIntegrationConfig | null | undefined,
): StyleResolution {
  return resolveStyleShared(toPairs(variations), config);
}
