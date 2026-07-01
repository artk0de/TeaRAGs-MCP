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

/** Drop a candidate whose REQUIRED kwarg the call omits — a runtime
 *  `ArgumentError: missing keyword`. A call `**`-splat (unknown runtime keys)
 *  or no captured kwargKeys ⇒ keep (missing evidence). Candidates with no
 *  recorded `kwargs` are kept. `kwargs.hasSplat` is reserved for the deferred
 *  extra-unknown-key direction. */
export class KwargNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    const keys = call.kwargKeys;
    if (keys === undefined || call.hasKwargSplat) return candidates;
    const have = new Set(keys);
    return candidates.filter((c) => {
      const kw = c.kwargs;
      if (!kw) return true;
      // (1) omitted-required — every required kwarg must be supplied.
      if (!kw.required.every((k) => have.has(k))) return false;
      // (2) extra-unknown — every passed key must be declared, UNLESS the def
      // has a `**` splat (accepts arbitrary keys) or `optional` was not captured
      // (full declared set unknown → conservative keep).
      if (kw.hasSplat || kw.optional === undefined) return true;
      const declared = new Set([...kw.required, ...kw.optional]);
      return keys.every((k) => declared.has(k));
    });
  }
}

/** Explicit-receiver call cannot reach a `private` method → drop those. */
export class VisibilityNarrower implements DispatchCandidateNarrower {
  narrow(_call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    return candidates.filter((c) => c.visibility !== "private");
  }
}

/** Block presence is legal-but-unused in Ruby (an unused block is silently
 *  ignored), so it DISCRIMINATES rather than proving incompatibility: when a
 *  call passes a block, prefer definers that yield/take a block — UNLESS none
 *  do, in which case keep all (the block is defensive, or yield-detection
 *  missed it). Never empties the set. `acceptsBlock === undefined` (not
 *  captured) is treated as a possible yielder → kept. */
export class BlockNarrower implements DispatchCandidateNarrower {
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    if (!call.passesBlock) return candidates;
    const yielders = candidates.filter((c) => c.acceptsBlock !== false);
    return yielders.length > 0 ? yielders : candidates;
  }
}

/** A literal receiver (`"s".m`, `[].m`) has a statically-certain core type T.
 *  Keep only candidates that reopen T in-project (enclosing class === T); none
 *  ⇒ empty the fan-out (every match is a coincidental same-name method on an
 *  unrelated class → wrong for a core-typed receiver). `classify` returns the
 *  core type name or null (non-literal / unknown ⇒ keep all). The literal→type
 *  map is language-specific and injected; the scope comparison is neutral. */
export class LiteralReceiverNarrower implements DispatchCandidateNarrower {
  constructor(private readonly classify: (receiver: string | null) => string | null) {}
  narrow(call: CallRef, candidates: SymbolDefinition[]): SymbolDefinition[] {
    const t = this.classify(call.receiver);
    if (t === null) return candidates;
    return candidates.filter((c) => c.scope[c.scope.length - 1] === t);
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
