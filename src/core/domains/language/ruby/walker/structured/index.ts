import { aasmExpander } from "./aasm.js";
import { enumExpander } from "./enum.js";
import { stateMachineExpander } from "./state_machine.js";
import type { StructuredMacroExpander } from "./types.js";

/**
 * Typed registry of structured class-body macro expanders.
 *
 * `macro-expansion.ts::expandClassBodyMacros` dispatches over this array
 * (mirroring the `FRAMEWORKS` pattern) — one pass of `.find()` replaces
 * the two imperative `if (macroName === …)` branches.
 *
 * Add a new structural macro: create an expander module here under `walker/structured/`
 * and append it to `STRUCTURED_MACROS`. No edits to `macro-expansion.ts` required.
 */
export type { StructuredMacroExpander } from "./types.js";
export { aasmExpander } from "./aasm.js";
export { enumExpander } from "./enum.js";
export { stateMachineExpander } from "./state_machine.js";

/** All structural macro expanders, in dispatch order. */
export const STRUCTURED_MACROS: readonly StructuredMacroExpander[] = [enumExpander, aasmExpander, stateMachineExpander];
