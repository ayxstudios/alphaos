import {
  resolveFigureCount as resolveShared,
  type FigureResolution,
} from "../figures";
import type { EtsyVariation, EtsyIntegrationConfig } from "./types";

export type { FigureResolution };

/** Adapter: Etsy variations -> shared resolver. */
export function resolveFigureCount(
  variations: EtsyVariation[],
  config: EtsyIntegrationConfig | null | undefined,
): FigureResolution {
  return resolveShared(
    (variations ?? []).map((v) => ({ name: v.formatted_name, value: v.formatted_value })),
    config,
  );
}
