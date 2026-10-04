/**
 * The IPC contract between `WorkingTreeGraphProcessBuilder` and the forked
 * `tree-graph-entry`: one request in, one reply out per build. The child is
 * warm — it serves build after build, one at a time — so each request carries
 * an id its reply echoes, and each reply reports the child's heap for the
 * spawner's recycle decision.
 * Node IPC serializes as JSON, so both shapes are plain data — and the entry
 * validates the request structurally instead of trusting the wire.
 */
import type { WorkingTreeGraphBuildInput, WorkingTreeGraphBuilt } from "./tree-graph-build.js";

/** A build request. `debug` carries the parent's `isDebug()` — the child has no bootstrap to set it. */
export interface WorkingTreeGraphEntryRequest {
  input: WorkingTreeGraphBuildInput;
  debug: boolean;
  /** The spawner's build id; the reply echoes it. */
  id?: number;
}

/** Asks an idle child to exit — how the spawner retires it (idle period, recycle, new ceiling, close). */
export interface WorkingTreeGraphEntryShutdown {
  kind: "shutdown";
}

/** Structural check of a shutdown off the wire. */
export function isWorkingTreeGraphEntryShutdown(value: unknown): value is WorkingTreeGraphEntryShutdown {
  return isRecord(value) && value.kind === "shutdown";
}

/** What the child reports beside every reply. */
interface WorkingTreeGraphEntryReplyMeta {
  /** The request's id, echoed. */
  id?: number;
  /** `process.memoryUsage().heapUsed` after the build — the spawner retires a child above its recycle fraction. */
  heapUsedBytes?: number;
}

/** The child's answer to one request. */
export type WorkingTreeGraphEntryReply = WorkingTreeGraphEntryReplyMeta &
  ({ kind: "built"; outcome: WorkingTreeGraphBuilt } | { kind: "failed"; reason: string });

/** Structural check of a request off the wire. */
export function isWorkingTreeGraphEntryRequest(value: unknown): value is WorkingTreeGraphEntryRequest {
  if (!isRecord(value) || typeof value.debug !== "boolean" || !isRecord(value.input)) return false;
  if (!isOptionalNumber(value.id)) return false;
  const { input } = value;
  return (
    typeof input.snapshotPath === "string" &&
    typeof input.outputRoot === "string" &&
    typeof input.physicalCollectionName === "string" &&
    input.physicalCollectionName.length > 0 &&
    typeof input.treeRoot === "string" &&
    isStringArray(input.changedRelPaths) &&
    isStringArray(input.deletedRelPaths) &&
    isRecord(input.providerConfig) &&
    typeof input.providerConfig.languageModulePath === "string" &&
    typeof input.providerConfig.migrationsModulePath === "string" &&
    (input.seed === undefined || isSeed(input.seed))
  );
}

/** The optional `seed` of a request: the previous graph's path and every path list `applySeedDelta` reads. */
function isSeed(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.dbPath === "string" &&
    isStringArray(value.changedRelPaths) &&
    isStringArray(value.deletedRelPaths) &&
    isStringArray(value.heldRelPaths) &&
    isStringArray(value.restoredRelPaths) &&
    isStringArray(value.seedChangedRelPaths) &&
    isStringArray(value.seedDeletedRelPaths)
  );
}

/** Structural check of a reply off the wire. */
export function isWorkingTreeGraphEntryReply(value: unknown): value is WorkingTreeGraphEntryReply {
  if (!isRecord(value) || !isOptionalNumber(value.id) || !isOptionalNumber(value.heapUsedBytes)) return false;
  if (value.kind === "failed") return typeof value.reason === "string";
  return value.kind === "built" && isRecord(value.outcome) && typeof value.outcome.dbPath === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === "number";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
