/**
 * `typeFactChannels` — a built `TypeFactStore` rendered as the
 * `Partial<FileExtraction>` a type-facts extraction pass returns (E1 seam 2).
 *
 * The store answers four questions; this decides which `FileExtraction` channel
 * each answer belongs to, once, so a language's annotation pass is
 * `sources → TypeFactStore.fromFacts(facts, ORDER) → typeFactChannels` and
 * nothing else. Python's E2 annotation pass is the first consumer.
 *
 * What it deliberately does NOT do is MERGE. Ruby's `walker/type-channels.ts`
 * publishes the same four channels but folds two other sources in around them —
 * a YARD `@return` overwrites body inference, and owner-qualified body inference
 * fills only where the store said nothing. Those are Ruby precedence decisions
 * that live inside Ruby's monolith (Model A), so Ruby keeps its own builder and
 * this helper stays a projection with no policy of its own.
 *
 * Empty is absent, everywhere: a chunk with no bindings produces no record, a
 * channel with no entries is never set, and the returned object for an empty
 * store has no keys at all. That is what lets `mergeExtraction` hold its
 * "absent stays absent" property without pruning after the fact — an empty `{}`
 * reaching the NDJSON spill moves the payload the schema-drift guard compares.
 */
import type { ChunkExtraction, FileExtraction } from "../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../contracts/types/language.js";
import type { TypeFactStore } from "./type-fact-store.js";

export function typeFactChannels(store: TypeFactStore, chunks: WalkContext["chunks"]): Partial<FileExtraction> {
  const out: Partial<FileExtraction> = {};

  // Per-chunk local bindings. `symbolId` is copied verbatim from the chunk list
  // — the pass never composes an id, so the merge matches the walker's own
  // record and a pass can never invent a chunk the chunker did not emit.
  // `calls: []` satisfies the required channel and is pruned by the merge's
  // empty check, so it never materialises on the walker's record.
  const chunkRecords: ChunkExtraction[] = [];
  for (const chunk of chunks) {
    const localBindings = store.localBindingsForChunk(chunk.startLine, chunk.endLine);
    if (Object.keys(localBindings).length === 0) continue;
    chunkRecords.push({
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      calls: [],
      localBindings,
    });
  }
  if (chunkRecords.length > 0) out.chunks = chunkRecords;

  const functionReturnTypes = store.returnTypeByMethod();
  if (Object.keys(functionReturnTypes).length > 0) out.functionReturnTypes = functionReturnTypes;

  const structuredReturnTypes = store.structuredReturnTypesMap();
  if (Object.keys(structuredReturnTypes).length > 0) out.structuredReturnTypes = structuredReturnTypes;

  const ivarTypes = store.ivarTypesMap();
  if (Object.keys(ivarTypes).length > 0) out.ivarTypes = ivarTypes;

  return out;
}
