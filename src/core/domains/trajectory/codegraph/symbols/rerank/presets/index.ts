import type { RerankPreset } from "../../../../../../contracts/types/reranker.js";

/**
 * Codegraph trajectory presets — pure single-trajectory presets only.
 *
 * Slice 1 placed `BlastRadiusPreset` here, but the preset weights `churn`
 * (a git signal); presets that span two trajectories are composites and
 * live in `domains/trajectory/composite/presets/`. The composite list is
 * supplied via `buildCompositePresets({ codegraph })` from
 * `api/internal/composition.ts` and reaches the reranker through
 * `resolvePresets(registry, composite)`.
 */
export const CODEGRAPH_SYMBOLS_PRESETS: RerankPreset[] = [];
