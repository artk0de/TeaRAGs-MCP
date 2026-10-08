/**
 * Every file's git maintenance readings — `git.file.commitCount`,
 * `git.file.bugFixRate`, `git.file.ageDays` — read back from the index payload
 * (bd tea-rags-mcp-r8hme.20).
 *
 * The architecture report ranks violations by the maintenance cost of the
 * files carrying them, each reading positioned in the collection's own
 * distribution, so it needs the readings of EVERY file, not only the carriers.
 * One payload-narrowed pass answers that, the way the commit-count read the
 * volatility gate used (`payload-file-commit-count-reader.ts`, measured 1.1 s
 * over 45k points and 4.0 s over 175k) does: every chunk of a file carries the
 * same file-scoped git signals, so the first chunk seen stands for its file.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { GitFileMaintenanceSignals } from "../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";

const FILE_MAINTENANCE_PAYLOAD_KEYS = [
  "relativePath",
  "git.file.commitCount",
  "git.file.bugFixRate",
  "git.file.ageDays",
];

/** The three readings per file; a file missing any numeric reading is absent. */
export async function readPayloadFileMaintenanceSignals(
  qdrant: Pick<QdrantManager, "scrollPayloadPages">,
  collectionName: string,
): Promise<Map<RelPath, GitFileMaintenanceSignals>> {
  const signals = new Map<RelPath, GitFileMaintenanceSignals>();
  for await (const page of qdrant.scrollPayloadPages(collectionName, FILE_MAINTENANCE_PAYLOAD_KEYS)) {
    for (const { payload } of page) {
      const { relativePath } = payload;
      if (typeof relativePath !== "string" || signals.has(relativePath)) continue;
      const reading = readFileMaintenanceSignals(payload);
      if (reading !== undefined) signals.set(relativePath, reading);
    }
  }
  return signals;
}

function readFileMaintenanceSignals(payload: Record<string, unknown>): GitFileMaintenanceSignals | undefined {
  const { git } = payload;
  if (typeof git !== "object" || git === null) return undefined;
  const { file } = git as { file?: unknown };
  if (typeof file !== "object" || file === null) return undefined;
  const { commitCount, bugFixRate, ageDays } = file as Record<string, unknown>;
  if (typeof commitCount !== "number" || typeof bugFixRate !== "number" || typeof ageDays !== "number") {
    return undefined;
  }
  return { commitCount, bugFixRate, ageDays };
}
