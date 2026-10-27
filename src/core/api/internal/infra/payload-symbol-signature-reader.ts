/**
 * One-line signatures of graph symbols, read from the index payload (bd tea-rags-mcp-afdpc): the call tree's
 * nodes carry the same `signature` a metaOnly search row carries, derived by the same `chunkSignature` from the
 * symbol's first chunk. One scroll for the whole page of nodes.
 */

import type { QdrantPointReader } from "../../../adapters/qdrant/ports.js";
import type { SymbolId } from "../../../contracts/types/codegraph.js";
import { chunkSignature } from "../../../domains/explore/index.js";

/** Points per requested id: namesakes and the `#partN` chunks of a split method are few. */
const POINTS_PER_SYMBOL = 4;

export async function readPayloadSymbolSignatures(
  qdrant: Pick<QdrantPointReader, "scrollBySymbolIds">,
  collectionName: string,
  symbolIds: readonly SymbolId[],
): Promise<Map<SymbolId, string>> {
  const wanted = [...new Set(symbolIds)];
  const out = new Map<SymbolId, string>();
  if (wanted.length === 0) return out;
  const points = await qdrant.scrollBySymbolIds(collectionName, wanted, wanted.length * POINTS_PER_SYMBOL);
  // The symbol's own first chunk: the lowest start line among the points carrying exactly its id.
  const first = new Map<SymbolId, { startLine: number; payload: Record<string, unknown> }>();
  for (const { payload } of points) {
    const { symbolId } = payload;
    if (typeof symbolId !== "string" || !wanted.includes(symbolId)) continue;
    const startLine = typeof payload.startLine === "number" ? payload.startLine : Number.MAX_SAFE_INTEGER;
    const held = first.get(symbolId);
    if (!held || startLine < held.startLine) first.set(symbolId, { startLine, payload });
  }
  for (const [symbolId, { payload }] of first) {
    const signature = chunkSignature(payload);
    if (signature !== undefined) out.set(symbolId, signature);
  }
  return out;
}
