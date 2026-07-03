/**
 * `state_machines` gem (and its legacy `state_machine` predecessor) structured
 * macro expander.
 *
 * `state_machine :status do state :active; event :activate end` synthesises a
 * predicate (`active?`) per `state` declaration and an event method + bang
 * (`activate` / `activate!`) per `event` declaration — the same inner grammar as
 * aasm, so the block-walk is the shared `expandStateEventBlock`. The leading
 * attribute symbol (`:status`) names the backing column and is NOT walked; only
 * the `state`/`event` block declarations produce methods.
 *
 * Gem-gated (`dsl/state_machines.ts` `structuredMacros: {state_machine}`,
 * `activatedBy {state_machines, state_machine}`): a project without the gem no
 * longer expands a `state_machine`-shaped block. Class-level scopes are omitted
 * for the same reason as aasm (conditional integration).
 */
import { expandStateEventBlock } from "./state-event-machine.js";
import type { StructuredMacroExpander } from "./types.js";

export const stateMachineExpander: StructuredMacroExpander = {
  macroName: "state_machine",
  expand: expandStateEventBlock,
};
