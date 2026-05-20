import type { RerankPreset } from "../../../../../../contracts/types/reranker.js";
import { BlastRadiusPreset } from "./blast-radius.js";

export { BlastRadiusPreset };

export const CODEGRAPH_SYMBOLS_PRESETS: RerankPreset[] = [new BlastRadiusPreset()];
