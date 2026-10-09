/**
 * Pure statistical tests — foundation layer (`core/infra/`), shared by the
 * co-change pair gate and the dependency norms (bd tea-rags-mcp-xb669.8).
 */

export { poissonUpperTail } from "./poisson.js";
export { binomialLowerTail, binomialUpperTail, poissonBinomialUpperTail, signTestPValue } from "./binomial.js";
export { mulberry32, seedFromKey } from "./seeded-random.js";
export { benjaminiHochbergRejectionCount, CONVENTIONAL_FDR_Q } from "./benjamini-hochberg.js";
