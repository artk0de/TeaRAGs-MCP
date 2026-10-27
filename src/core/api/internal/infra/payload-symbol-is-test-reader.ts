/**
 * Whether a symbolId names an indexed TEST chunk, read from the index payload (`isTest`, written by
 * `classify(relPath).isTest`). Test code is not walked into the codegraph, so the graph tools use this to tell an
 * id the graph never holds (a test chunk) from one that does not exist.
 */

import type { QdrantPointReader } from "../../../adapters/qdrant/ports.js";
import type { SymbolId } from "../../../contracts/types/codegraph.js";

/** A handful of points: namesakes of one id are few, and one test row settles the answer. */
const PROBE_POINT_LIMIT = 8;

export async function readPayloadSymbolIsTest(
  qdrant: Pick<QdrantPointReader, "scrollBySymbolIds">,
  collectionName: string,
  symbolId: SymbolId,
): Promise<boolean> {
  const points = await qdrant.scrollBySymbolIds(collectionName, [symbolId], PROBE_POINT_LIMIT);
  return points.some((point) => point.payload.symbolId === symbolId && point.payload.isTest === true);
}
