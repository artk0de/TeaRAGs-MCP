/**
 * Pure numeric code — primitives layer (`core/primitives/`), I/O-free and
 * importable by every core layer: vector math, the cosine score background,
 * and the statistical tests under `statistics/`. Consumers import this barrel,
 * never a file behind it.
 */

export { cosine } from "./vector-math.js";
export { computeScoreBackground } from "./score-background.js";
export {
  benjaminiHochbergRejectionCount,
  binomialLowerTail,
  binomialUpperTail,
  CONVENTIONAL_FDR_Q,
  geometricUpperTail,
  hypergeometricUpperTail,
  mulberry32,
  poissonBinomialUpperTail,
  poissonUpperTail,
  seedFromKey,
  sidakCorrectedMinimumPValue,
  signTestPValue,
} from "./statistics/index.js";
