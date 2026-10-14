/**
 * The production export table behind the remedy resolver (bd
 * tea-rags-mcp-89k7k.1.19.6). The facade surface is the facade-contract
 * port's own `indexedSurfaceOf` — one reading, never a second. Where a name is
 * DECLARED is read off the same production file edges the contract port and
 * leakingAbstraction read: the export names each import statement recorded
 * (`importedExportNames`) and forwarded (`reexportedExportNames`).
 *
 * A file holds a name when an edge takes the name from it or re-exports the
 * name out of it; a holder that forwards the name itself (a named re-export
 * edge carrying it) is a barrel, not a declarer. What is left declares it.
 *
 * The edges are the review's EFFECTIVE edges: the indexed edges of every
 * source the review's overlay did not re-read, plus the overlay's edges of each
 * re-read source — so a name the diff itself declares is seen. A skipped read
 * (the overlay's `unsupported()`) keeps its indexed edges: a missing fact is
 * never "no edge".
 *
 * Absence of the fact is never "no declarer": a name no recorded edge names —
 * a language without an export table, or a name nobody imports — answers
 * `undefined`, and so does a holder with a whole-module re-export (`export *`),
 * which may forward the name without recording it.
 */

import type { FileDependencyEdge } from "../../../../contracts/types/codegraph.js";
import { WHOLE_MODULE_EXPORT_NAME, type ExportTableReader } from "../diff-detector-run.js";

/** The export names one file edge records — what the reader needs of an indexed or overlay edge. */
type ExportNamingEdge = Pick<
  FileDependencyEdge,
  "sourceRelPath" | "targetRelPath" | "importedExportNames" | "reexportedExportNames"
>;

/** What the reader needs of the review's edge overlay (`ReviewEdgeOverlay` satisfies it). */
export interface ReviewEdgeFacts {
  readonly masked: ReadonlySet<string>;
  edgesFrom: (relPath: string) => readonly ExportNamingEdge[];
  unsupported: () => readonly { relPath: string }[];
}

export class WiredExportTableReader implements ExportTableReader {
  /** Every file holding a name — the target an edge takes or re-exports it from. */
  private readonly holdersByName = new Map<string, Set<string>>();
  /** The names each file forwards out by a named re-export. */
  private readonly forwardedByFile = new Map<string, Set<string>>();
  /** Files with a whole-module re-export — they may forward any name unrecorded. */
  private readonly wildcardForwarders = new Set<string>();

  constructor(
    private readonly contract: Pick<ExportTableReader, "indexedSurfaceOf">,
    indexedEdges: readonly FileDependencyEdge[],
    overlay?: ReviewEdgeFacts,
  ) {
    for (const edge of effectiveEdges(indexedEdges, overlay)) {
      for (const name of edge.importedExportNames ?? []) this.hold(name, edge.targetRelPath);
      for (const name of edge.reexportedExportNames ?? []) {
        if (name === WHOLE_MODULE_EXPORT_NAME) {
          this.wildcardForwarders.add(edge.sourceRelPath);
          continue;
        }
        this.hold(name, edge.targetRelPath);
        const forwarded = this.forwardedByFile.get(edge.sourceRelPath) ?? new Set<string>();
        forwarded.add(name);
        this.forwardedByFile.set(edge.sourceRelPath, forwarded);
      }
    }
  }

  indexedSurfaceOf(facade: string): readonly string[] | undefined {
    return this.contract.indexedSurfaceOf(facade);
  }

  declarersOf(name: string): readonly string[] | undefined {
    const holders = this.holdersByName.get(name);
    if (holders === undefined) return undefined;
    const declarers = [...holders].filter((file) => this.forwardedByFile.get(file)?.has(name) !== true);
    if (declarers.some((file) => this.wildcardForwarders.has(file))) return undefined;
    return declarers.sort();
  }

  private hold(name: string, relPath: string): void {
    if (name === WHOLE_MODULE_EXPORT_NAME) return;
    const holders = this.holdersByName.get(name) ?? new Set<string>();
    holders.add(relPath);
    this.holdersByName.set(name, holders);
  }
}

/** The indexed edges with every successfully re-read source's edges swapped for the overlay's. */
function effectiveEdges(
  indexedEdges: readonly FileDependencyEdge[],
  overlay: ReviewEdgeFacts | undefined,
): readonly ExportNamingEdge[] {
  if (overlay === undefined) return indexedEdges;
  const skipped = new Set(overlay.unsupported().map(({ relPath }) => relPath));
  const refreshed = [...overlay.masked].filter((relPath) => !skipped.has(relPath));
  const refreshedSet = new Set(refreshed);
  return [
    ...indexedEdges.filter((edge) => !refreshedSet.has(edge.sourceRelPath)),
    ...refreshed.flatMap((relPath) => overlay.edgesFrom(relPath)),
  ];
}
