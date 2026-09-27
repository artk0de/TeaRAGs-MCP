/**
 * Every file's `git.file.commitCount`, read back from the index payload
 * (bd tea-rags-mcp-r8hme.14).
 *
 * The main-sequence detector gates the zone of pain on how often a component
 * changes, and needs the reading for every file of the judged graph — its
 * volatility cut is drawn over all judged components and floored at the median
 * file. One payload-narrowed pass over the collection answers that: every
 * chunk of a file carries the same file-scoped git signals, so the first chunk
 * seen stands for its file. Measured 1.1 s over 45k points (the self-index)
 * and 4.0 s over 175k (taxdome); a per-file scroll would cost one round trip
 * per file.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";

const FILE_COMMIT_COUNT_PAYLOAD_KEYS = ["relativePath", "git.file.commitCount"];

/** Commit count per file; a file with no numeric `git.file.commitCount` is absent. */
export async function readPayloadFileCommitCounts(
  qdrant: Pick<QdrantManager, "scrollPayloadPages">,
  collectionName: string,
): Promise<Map<RelPath, number>> {
  const counts = new Map<RelPath, number>();
  for await (const page of qdrant.scrollPayloadPages(collectionName, FILE_COMMIT_COUNT_PAYLOAD_KEYS)) {
    for (const { payload } of page) {
      const { relativePath } = payload;
      if (typeof relativePath !== "string" || counts.has(relativePath)) continue;
      const commitCount = readFileCommitCount(payload);
      if (commitCount !== undefined) counts.set(relativePath, commitCount);
    }
  }
  return counts;
}

function readFileCommitCount(payload: Record<string, unknown>): number | undefined {
  const { git } = payload;
  if (typeof git !== "object" || git === null) return undefined;
  const { file } = git as { file?: unknown };
  if (typeof file !== "object" || file === null) return undefined;
  const { commitCount } = file as { commitCount?: unknown };
  return typeof commitCount === "number" ? commitCount : undefined;
}
