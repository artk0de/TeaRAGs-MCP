/**
 * Pure statistical tests — foundation layer (`core/infra/`), shared by the
 * co-change pair gate and the dependency norms (bd tea-rags-mcp-xb669.8).
 */

export { poissonLowerTail, poissonUpperTail } from "./poisson.js";
export { benjaminiHochbergRejectionCount, CONVENTIONAL_FDR_Q } from "./benjamini-hochberg.js";
