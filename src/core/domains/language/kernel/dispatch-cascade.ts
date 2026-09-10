import type { DispatchCascadeOptions } from "../../../contracts/types/language.js";
import {
  ArityNarrower,
  BlockNarrower,
  DuckVocabularyNarrower,
  KwargNarrower,
  LiteralReceiverNarrower,
  VisibilityNarrower,
  type DispatchCandidateNarrower,
} from "./dispatch-narrowing.js";

export type { DispatchCascadeOptions };

/**
 * The untyped-dispatch narrowing CASCADE, in the one order every language runs
 * it (relocated from `RubyDynamicDispatchResolver`'s private array, bd
 * tea-rags-mcp-w205u / E4.1). The narrowers themselves are neutral and stay in
 * `dispatch-narrowing.ts`; what is shared here is the ORDER and the two
 * language-data injections.
 *
 * Language-specific narrowers run FIRST because they can empty the set outright
 * — a duck-vocabulary member has no meaningful in-project target at all, and a
 * literal receiver's type is statically certain — and the signature narrowers,
 * which only ever drop PROVEN-incompatible candidates, run after. A language
 * that supplies neither gets the signature half, which is exactly what Python
 * needs: `VisibilityNarrower` and `BlockNarrower` keep every candidate when the
 * walker records no `visibility` / `acceptsBlock`, so they are inert rather
 * than wrong there.
 */
export function buildDispatchCascade(opts: DispatchCascadeOptions = {}): DispatchCandidateNarrower[] {
  const cascade: DispatchCandidateNarrower[] = [];
  if (opts.duckVocabulary !== undefined) cascade.push(new DuckVocabularyNarrower(opts.duckVocabulary));
  if (opts.classifyLiteralReceiver !== undefined) {
    cascade.push(new LiteralReceiverNarrower(opts.classifyLiteralReceiver));
  }
  cascade.push(new ArityNarrower(), new KwargNarrower(), new VisibilityNarrower(), new BlockNarrower());
  return cascade;
}
