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
  treeEdgesFrom: (
    relPath: string,
    indexedEdgesFrom: (relPath: string) => readonly FileDependencyEdge[],
  ) => readonly ExportNamingEdge[];
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
    private readonly overlay?: ReviewEdgeFacts,
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

  /**
   * The facade's surface AS THE REVIEW SEES IT: a facade the diff re-read
   * serves the names its working-tree edges re-export, so an export the diff
   * adds is not proposed again. Remedy-only — the facade-contract detector
   * keeps judging the INDEXED surface through its own port. A facade not
   * re-read, whose read was skipped, or whose re-read recorded no names keeps
   * the contract's surface: a missing fact is never an empty surface.
   */
  indexedSurfaceOf(facade: string): readonly string[] | undefined {
    const reread = this.overlay?.masked.has(facade) === true && this.overlay.unsupported().every(skippedIsNot(facade));
    if (!reread || this.overlay === undefined) return this.contract.indexedSurfaceOf(facade);
    const names = new Set(this.overlay.edgesFrom(facade).flatMap((edge) => edge.reexportedExportNames ?? []));
    names.delete(WHOLE_MODULE_EXPORT_NAME);
    return names.size > 0 ? [...names] : this.contract.indexedSurfaceOf(facade);
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

function skippedIsNot(relPath: string): (skip: { relPath: string }) => boolean {
  return (skip) => skip.relPath !== relPath;
}

/** The tree's edges: every source's edges by the overlay's tree-edge rule (`ReviewEdgeOverlay#treeEdgesFrom`). */
function effectiveEdges(
  indexedEdges: readonly FileDependencyEdge[],
  overlay: ReviewEdgeFacts | undefined,
): readonly ExportNamingEdge[] {
  if (overlay === undefined) return indexedEdges;
  const indexedBySource = new Map<string, FileDependencyEdge[]>();
  for (const edge of indexedEdges) {
    const edges = indexedBySource.get(edge.sourceRelPath) ?? [];
    edges.push(edge);
    indexedBySource.set(edge.sourceRelPath, edges);
  }
  const indexedEdgesFrom = (relPath: string): readonly FileDependencyEdge[] => indexedBySource.get(relPath) ?? [];
  const sources = new Set([...indexedBySource.keys(), ...overlay.masked]);
  return [...sources].flatMap((relPath) => overlay.treeEdgesFrom(relPath, indexedEdgesFrom));
}
