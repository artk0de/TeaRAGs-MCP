import type { CallContext, CallRef, DispatchEdge, SymbolDefinition } from "../../../contracts/types/codegraph.js";

/** A candidate filter in the untyped-dispatch narrowing cascade (bd xlnub).
 *  Drops a candidate ONLY on PROVEN incompatibility; missing evidence ⇒ keep. */
export interface DispatchCandidateNarrower {
  narrow: (call: CallRef, candidates: SymbolDefinition[], ctx: CallContext) => SymbolDefinition[];
}

/** Keep `c` iff its positional arity can accept `call.argCount`. */
export class ArityNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    const n = call.argCount;
    if (n === undefined) return candidates;
    return candidates.filter((c) => {
      const a = c.arity;
      if (!a) return true;
      if (n < a.minRequired) return false;
      if (!a.hasSplat && n > a.maxPositional) return false;
      return true;
    });
  }
}

/** Explicit-receiver call cannot reach a `private` method → drop those. */
export class VisibilityNarrower implements DispatchCandidateNarrower {
  narrow(_call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    return candidates.filter((c) => c.visibility !== "private");
  }
}

/** Members in the language duck/runtime vocabulary are never short-name
 *  resolvable to a meaningful in-project target → empty the whole fan-out. */
export class DuckVocabularyNarrower implements DispatchCandidateNarrower {
  constructor(private readonly vocab: ReadonlySet<string>) {}
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    return this.vocab.has(call.member) ? [] : candidates;
  }
}

const edgeFor = (c: SymbolDefinition, confidence: number): DispatchEdge => ({
  sourceSymbolId: null,
  targetRelPath: c.relPath,
  targetSymbolId: c.symbolId,
  edgeKind: "dynamic",
  confidence,
});

/** Run the cascade, then the consumer-split terminal: 1 survivor → one edge
 *  confidence 1.0; m>1 → m edges confidence discount/m; 0 → []. */
export function resolveNarrowedFanout(
  call: CallRef,
  candidates: SymbolDefinition[],
  ctx: CallContext,
  narrowers: DispatchCandidateNarrower[],
  discount: number,
): DispatchEdge[] {
  let survivors = candidates;
  for (const narrower of narrowers) {
    survivors = narrower.narrow(call, survivors, ctx);
    if (survivors.length === 0) return [];
  }
  if (survivors.length === 1) return [edgeFor(survivors[0], 1.0)];
  const confidence = discount / survivors.length;
  return survivors.map((c) => edgeFor(c, confidence));
}
