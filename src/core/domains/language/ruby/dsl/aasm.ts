/**
 * AASM state-machine gem. The `aasm do … end` block is a STRUCTURED macro: its
 * `state` / `event` declarations are walked by `walker/structured/aasm.ts`, not
 * projected through a flat `declares(base)`, so this vocabulary carries no
 * declaring `entries` body beyond the `aasm` keyword itself (chunker
 * state-machine grouping + external bare-call classification). It ACTIVATES the
 * aasm structured expander through `structuredMacros`.
 *
 * Gem-gated by `activatedBy {aasm}`: a project without the aasm gem no longer
 * synthesises state predicates / event methods from an `aasm`-shaped block
 * (previously the expander was unconditional). Byte-identical under the FULL
 * catalogue (no Gemfile → every gated grammar active, so `aasm` ∈
 * activeStructuredMacros exactly as before). Relocated the `aasm` entry here from
 * `rails.ts` so the keyword and its structured expander share one gate
 * (bd tea-rags-mcp-o5kwh / lawlq.3).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";

export const AASM_VOCABULARY = defineFrameworkVocabulary("aasm", { aasm: { category: "state-machine" } }, undefined, {
  activatedBy: new Set(["aasm"]),
  structuredMacros: new Set(["aasm"]),
});
