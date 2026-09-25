/**
 * File scope — reduces a `level: "file"` hit to the fields that describe the
 * FILE (bd tea-rags-mcp-mwq0k).
 *
 * A file hit is the payload of one representative chunk. Everything on it that
 * describes that chunk — its line range, symbol, chunk-level trajectory
 * signals, its body — is noise at file level, and worse, it reads as a claim
 * about the file. The reduction keeps:
 *
 *   - `relativePath`, the key {@link FileLevelGrouper} collapses on — the hit's
 *     identity, kept whatever the descriptors declare;
 *   - every flat key a payload signal descriptor declares `level: "file"`;
 *   - every trajectory namespace (`git`, `codegraph`, …) a nested descriptor
 *     names, minus each `chunk` branch inside it.
 *
 * Anything else — undeclared chunker keys (`navigation`, `headingPath`), the
 * chunk body, keys a future chunker adds — is dropped. The set is derived from
 * the descriptors, so a new signal defaults to chunk scope until it says
 * otherwise.
 *
 * This is RESPONSE shaping: it runs after rerank, which still reads the full
 * representative payload (chunk signals for alpha-blending, `language` /
 * `chunkType` for overlay labels).
 *
 * Pure data transformer, no I/O.
 */

import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import { FILE_GROUP_KEY } from "./file-level.js";

/** Which payload keys survive the reduction. Build once per descriptor set. */
export interface FileScope {
  /** Flat keys describing the whole file. */
  readonly flatKeys: ReadonlySet<string>;
  /** Trajectory namespaces whose non-chunk branches are kept. */
  readonly namespaces: ReadonlySet<string>;
}

/** Segment naming a signal's level inside a nested payload key. */
const CHUNK_LEVEL = "chunk";
const LEVEL_SEGMENTS: ReadonlySet<string> = new Set(["file", CHUNK_LEVEL]);

/** Derive the file scope from the payload signal descriptors. */
export function fileScopeOf(payloadSignals: readonly PayloadSignalDescriptor[]): FileScope {
  const flatKeys = new Set<string>([FILE_GROUP_KEY]);
  const namespaces = new Set<string>();
  for (const signal of payloadSignals) {
    const segments = signal.key.split(".");
    if (segments.length === 1) {
      if (signal.level === "file") flatKeys.add(signal.key);
    } else if (segments.slice(1).some((segment) => LEVEL_SEGMENTS.has(segment))) {
      namespaces.add(segments[0]);
    }
  }
  return { flatKeys, namespaces };
}

/** Reduce a representative chunk payload to its file-scoped fields. */
export function reduceToFileScope(payload: Record<string, unknown>, scope: FileScope): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (scope.flatKeys.has(key)) {
      reduced[key] = value;
    } else if (scope.namespaces.has(key) && isPlainRecord(value)) {
      const branch = withoutChunkBranches(value);
      if (Object.keys(branch).length > 0) reduced[key] = branch;
    }
  }
  return reduced;
}

/**
 * Copy a namespace subtree without its `chunk` branches, at any depth
 * (`git.chunk`, `codegraph.symbols.chunk`). A subtree left empty is dropped.
 */
function withoutChunkBranches(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === CHUNK_LEVEL) continue;
    if (key !== "file" && isPlainRecord(value)) {
      const branch = withoutChunkBranches(value);
      if (Object.keys(branch).length > 0) out[key] = branch;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
