import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import { ChunkDensitySignal } from "./chunk-density.js";
import { ChunkSizeSignal } from "./chunk-size.js";
import { DocumentationSignal } from "./documentation.js";
import { ImportsSignal } from "./imports.js";
import { PathRiskSignal } from "./path-risk.js";
import { SimilaritySignal } from "./similarity.js";

export { ChunkDensitySignal } from "./chunk-density.js";
export { ChunkSizeSignal } from "./chunk-size.js";
export { DocumentationSignal } from "./documentation.js";
export { ImportsSignal } from "./imports.js";
export { PathRiskSignal } from "./path-risk.js";
export { SimilaritySignal } from "./similarity.js";

export const staticDerivedSignals: DerivedSignalDescriptor[] = [
  new SimilaritySignal(),
  new ChunkSizeSignal(),
  new ChunkDensitySignal(),
  new DocumentationSignal(),
  new ImportsSignal(),
  new PathRiskSignal(),
];
