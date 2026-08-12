/**
 * The per-chunk Ruby extraction pass.
 *
 * Turns the chunker's line ranges into the `ChunkExtraction[]` a FileExtraction
 * carries: each record gets the calls it OWNS, the signature of the `def` that
 * starts on its first line, and — when type tracking is on — the local bindings
 * in force inside it.
 *
 * The pass has a second product. Typing an argument at a call site needs the
 * type environment of whichever chunk owns that call's LINE, and only this pass
 * knows what each chunk knew. So it also hands back `siteContextAt`, a line →
 * `KnownTargetCallSite` lookup over the same per-chunk environments. Both
 * products come from one walk of `input.chunks`; the caller keeps neither the
 * intermediate site list nor the innermost-chunk attribution rules.
 */

import type { CallRef, ChunkExtraction, LocalBinding } from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks } from "../../kernel/assign-calls-to-chunks.js";
import type { RubyDslCatalogue } from "../dsl/index.js";
import type { RubyFileTypeEnv } from "./file-type-env.js";
import { bindCompoundReceiverChains, collectRubyLocalCallBindingsForChunk } from "./local-bindings.js";
import { collectRubyMethodSignatures } from "./method-signatures.js";
import type { KnownTargetCallSite } from "./param-arg-types.js";
import type { RubyExtractInput } from "./walker.js";

export interface RubyChunkPassOutput {
  /** One record per entry of `input.chunks`, in the same order. */
  readonly chunks: ChunkExtraction[];
  /**
   * Type environment in force at a source line — the environment of the
   * INNERMOST chunk containing it. Lines inside no chunk (top-level statements)
   * get file scope with no bindings.
   */
  readonly siteContextAt: (line: number) => KnownTargetCallSite;
}

export function buildRubyChunkExtractions(
  input: RubyExtractInput,
  calls: CallRef[],
  typeEnv: RubyFileTypeEnv,
  catalogue: RubyDslCatalogue,
): RubyChunkPassOutput {
  const { enabled: trackTypes, store, associationTypes, ivarFieldTypes } = typeEnv;
  // Innermost-chunk attribution: assign each call to ONE chunk only —
  // the smallest containing range, ties broken by deeper scope length.
  // Without this guard, a call inside `module A { class B { def m ... } }`
  // lands on all four overlapping chunks (file/module/class/method) and
  // inflates caller-edge counts by the nesting depth (bd tea-rags-mcp-8fnu).
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  // Arity + visibility per method def (bd xlnub Task 2). Keyed by 1-based
  // start line — the same line the chunker assigns to the method's chunk.
  const methodSigs = collectRubyMethodSignatures(input.tree.rootNode);
  // Per-chunk type environments, in `input.chunks` order, so a known-target call
  // site can be typed against the bindings of the chunk that OWNS its line
  // (bd tea-rags-mcp-bvalc). Filled during the chunk loop, read after it.
  const chunkSites: (KnownTargetCallSite & { startLine: number; endLine: number })[] = [];
  const byChunk: ChunkExtraction[] = input.chunks.map((c, chunkIndex) => {
    const base: ChunkExtraction = {
      symbolId: c.symbolId,
      scope: c.scope,
      startLine: c.startLine,
      endLine: c.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    const sig = c.startLine !== undefined ? methodSigs.get(c.startLine) : undefined;
    if (sig !== undefined) {
      base.arity = sig.arity;
      // Positional names map a call site's argument INDEX to a parameter NAME at
      // the pass-1→pass-2 barrier (bd tea-rags-mcp-bvalc). Omitted when the
      // leading required run is empty — nothing to map.
      if (sig.paramNames.length > 0) base.paramNames = sig.paramNames;
      base.visibility = sig.visibility;
      if (sig.kwargs !== undefined) base.kwargs = sig.kwargs;
      base.acceptsBlock = sig.acceptsBlock;
      // Only ever set when TRUE — absent means "carries a real body", which is
      // the overwhelming majority of defs (bd tea-rags-mcp-bcdfe).
      if (sig.isAbstractStub) base.isAbstractStub = true;
    }
    if (trackTypes) {
      // Store provides YARD + AST param/local bindings (position-filtered to chunk).
      const localBindings = store.localBindingsForChunk(c.startLine, c.endLine);
      // Compound-receiver association-chain pass (B1): binds prefixes of dotted
      // chain receivers (`event.user → User`, `event.user.agents → Agent`) using
      // the per-class association map. Runs after the store pass so root-segment
      // types are already established in localBindings before chain resolution.
      if (Object.keys(associationTypes).length > 0) {
        const push = (name: string, type: string, line: number): void => {
          (localBindings[name] ??= []).push({ line, type } as LocalBinding);
        };
        bindCompoundReceiverChains(input.tree.rootNode, c.startLine, c.endLine, associationTypes, localBindings, push);
      }
      if (Object.keys(localBindings).length > 0) base.localBindings = localBindings;
      // `localCallBindings` (var → called method) pairs with the run-global
      // `functionReturnTypes` so the resolver binds `x = recv.meth(); x.member`
      // to `<meth's return type>#member` (cai0 a71lj, same channel as Go).
      const callBindings = collectRubyLocalCallBindingsForChunk(input.tree.rootNode, c.startLine, c.endLine, catalogue);
      if (Object.keys(callBindings).length > 0) base.localCallBindings = callBindings;
      // Type environment a known-target call site on these lines inherits
      // (bd tea-rags-mcp-bvalc).
      chunkSites.push({
        startLine: c.startLine,
        endLine: c.endLine,
        scope: c.scope,
        localBindings: base.localBindings,
        classFields: ivarFieldTypes[c.scope.join("::")],
      });
    }
    return base;
  });
  // Innermost chunk owning a line — the narrowest containing range, ties broken
  // by deeper scope, mirroring `assignCallsToInnermostChunks`. No chunk contains
  // the line (a top-level statement) ⇒ file scope with no type environment.
  const siteContextAt = (line: number): KnownTargetCallSite => {
    let best: (typeof chunkSites)[number] | undefined;
    for (const site of chunkSites) {
      if (line < site.startLine || line > site.endLine) continue;
      if (
        best === undefined ||
        site.endLine - site.startLine < best.endLine - best.startLine ||
        (site.endLine - site.startLine === best.endLine - best.startLine && site.scope.length > best.scope.length)
      ) {
        best = site;
      }
    }
    return best ?? { scope: [] };
  };
  return { chunks: byChunk, siteContextAt };
}
