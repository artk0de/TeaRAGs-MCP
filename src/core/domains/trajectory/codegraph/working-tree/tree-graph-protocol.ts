/**
 * The IPC contract between `WorkingTreeGraphProcessBuilder` and the forked
 * `tree-graph-entry`: one request in, one reply out, then the child exits.
 * Node IPC serializes as JSON, so both shapes are plain data — and the entry
 * validates the request structurally instead of trusting the wire.
 */
import type { WorkingTreeGraphBuildInput, WorkingTreeGraphBuilt } from "./tree-graph-build.js";

/** The one message the spawner sends. `debug` carries the parent's `isDebug()` — the child has no bootstrap to set it. */
export interface WorkingTreeGraphEntryRequest {
  input: WorkingTreeGraphBuildInput;
  debug: boolean;
}

/** The one message the child sends back before exiting. */
export type WorkingTreeGraphEntryReply =
  | { kind: "built"; outcome: WorkingTreeGraphBuilt }
  | { kind: "failed"; reason: string };

/** Structural check of a request off the wire. */
export function isWorkingTreeGraphEntryRequest(value: unknown): value is WorkingTreeGraphEntryRequest {
  if (!isRecord(value) || typeof value.debug !== "boolean" || !isRecord(value.input)) return false;
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
    typeof input.providerConfig.migrationsModulePath === "string"
  );
}

/** Structural check of a reply off the wire. */
export function isWorkingTreeGraphEntryReply(value: unknown): value is WorkingTreeGraphEntryReply {
  if (!isRecord(value)) return false;
  if (value.kind === "failed") return typeof value.reason === "string";
  return value.kind === "built" && isRecord(value.outcome) && typeof value.outcome.dbPath === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
