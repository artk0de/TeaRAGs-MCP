/**
 * AASM gem state-machine structured macro expander.
 *
 * Synthesises a predicate (`sleeping?`) per `state` declaration and an event
 * method + bang (`run` / `run!`) per `event` declaration from an `aasm do…end`
 * block. Gated on the outer `aasm` macro name so stray inner `state`/`event`
 * calls elsewhere in the class body are never expanded.
 *
 * The block-walk is shared with the state_machines gem (identical inner grammar)
 * via `expandStateEventBlock` — this module only binds it under the `aasm` name.
 *
 * Class-level scopes (`Model.sleeping`) are intentionally omitted — they are
 * conditional on `create_scopes` and the predicate/event methods are always made.
 */
import { expandStateEventBlock } from "./state-event-machine.js";
import type { StructuredMacroExpander } from "./types.js";

export const aasmExpander: StructuredMacroExpander = {
  macroName: "aasm",
  expand: expandStateEventBlock,
};
