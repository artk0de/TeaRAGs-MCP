import type { CycleScope, GraphEdges, GraphFileNode, RelPath, SymbolId } from "../../../contracts/types/codegraph.js";

export type DaemonOp =
  | "handshake"
  | "upsertFile"
  | "removeSymbolsForFile"
  | "computeAndPersistCyclesAndSignals"
  | "checkpoint"
  | "finalizeReindex"
  // Full-proxy reads — the daemon is the sole opener of the DuckDB file, so
  // GraphFacade's three read methods route through the daemon's own RW
  // connection instead of a (conflicting) cross-process READ_ONLY attach.
  | "getCallers"
  | "getCallees"
  | "findCycles";

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params:
    | { collection: string } // handshake | checkpoint | computeAndPersistCyclesAndSignals
    | { collection: string; node: GraphFileNode; edges: GraphEdges } // upsertFile
    | { collection: string; relPath: RelPath } // removeSymbolsForFile
    | { collection: string; oldVersion: string; newVersion: string } // finalizeReindex
    | { collection: string; symbolId: SymbolId } // getCallers | getCallees
    | { collection: string; scope: CycleScope }; // findCycles
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** One JSON object per line. `\n` is the frame delimiter (JSON.stringify never emits a raw newline). */
export function encodeFrame(msg: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Split a buffer on newlines; return complete frames and the partial trailing `rest`. */
export function decodeFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.length > 0), rest };
}
