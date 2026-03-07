import type { RerankPreset } from "../../../../contracts/types/reranker.js";
import { DecompositionPreset } from "./decomposition.js";
import { RelevancePreset } from "./relevance.js";

export { DecompositionPreset } from "./decomposition.js";
export { RelevancePreset } from "./relevance.js";

export const STATIC_PRESETS: RerankPreset[] = [new RelevancePreset(), new DecompositionPreset()];
