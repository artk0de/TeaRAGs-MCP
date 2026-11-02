/** Pure project renderers; importing them must not initialize backend adapters. */
export { formatIndexHolesLine } from "../../contracts/index-holes.js";
export { formatRustcDriverLine } from "../../contracts/rustc-driver-status.js";
export { isOptimizerFailure, renderOptimizerRecoveryCommand } from "../../contracts/optimizer-recovery.js";
export { formatResolveRate } from "../../contracts/resolve-rate.js";
