/**
 * `state_machines` gem (and its legacy `state_machine` predecessor). The
 * `state_machine :attr do … end` block is a STRUCTURED macro: its `state` /
 * `event` declarations are walked by `walker/structured/state_machine.ts`
 * (sharing aasm's `state`/`event` block-walk), not projected through a flat
 * `declares(base)` — so this vocabulary carries only the `state_machine` keyword
 * entry itself (chunker state-machine grouping + external bare-call
 * classification). It ACTIVATES the structured expander through
 * `structuredMacros`.
 *
 * Gem-gated by `activatedBy {state_machines, state_machine}` — the maintained
 * fork ships as `state_machines`, the original as `state_machine`; either gem
 * name activates the grammar. Byte-identical under the FULL catalogue (no Gemfile
 * → every gated grammar active, so `state_machine` ∈ activeStructuredMacros).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const STATE_MACHINES_VOCABULARY = defineFrameworkVocabulary(
  "state_machines",
  { state_machine: { category: "state-machine" } },
  undefined,
  {
    activatedBy: new Set(["state_machines", "state_machine"]),
    structuredMacros: new Set(["state_machine"]),
  },
);
