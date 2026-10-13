/**
 * The symbol table one diff-scoped review resolves file edges against (bd
 * tea-rags-mcp-vdhjc). During indexing a language's `resolveFileEdges` reads a
 * RUN-GLOBAL table pass 1 built over every file; a review walks only the
 * diff's files, so it rebuilds that table from what the index persisted — the
 * same two reads the codegraph pool's cold-start hydration makes
 * (`hydrateCodegraphSymbolTable`): every `cg_symbols` definition and every
 * file of the graph's file table (symbol-free files are members too, bd
 * tea-rags-mcp-o7ifx) — and then overlays the working tree on it:
 *
 * - a touched code file the tree holds is a member, one it lost is not (its
 *   definitions leave with it);
 * - a reviewed file's definitions are the ones its tree text declares, not the
 *   index's;
 * - on the base side's second read only, a touched file's definitions are the
 *   ones its BASE blob declared (bd tea-rags-mcp-slsia).
 *
 * The read goes through the review's `GraphDbClient` handle, so a daemon-held
 * database answers through the daemon like every other review read.
 *
 * Hydrating every row rather than a per-import query is deliberate: the
 * resolvers ask synchronously (`GlobalSymbolTable` is a sync port) and Ruby's
 * chain asks by fully-qualified AND short name, so the set of rows a file needs
 * is not known before resolving it. One bulk read per review, shared by every
 * section that walks the diff.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type {
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  RelPath,
  SymbolDefinition,
} from "../../../contracts/types/codegraph.js";
import { CODEGRAPH_LANGUAGE_BY_EXTENSION } from "../../../domains/trajectory/codegraph/index.js";
import { InMemoryGlobalSymbolTable, symbolDefinitionsOf } from "../../../domains/trajectory/codegraph/symbols/index.js";

/** The index's persisted codegraph rows a review's table is hydrated from. */
export interface IndexedSymbolRows {
  /** Every definition `cg_symbols` holds. */
  readonly definitions: readonly SymbolDefinition[];
  /** Every file of the graph's file table, symbol-free ones included. */
  readonly files: readonly RelPath[];
}

/** The rows, or why the index could not supply them — never an empty stand-in. */
export type IndexedSymbolRowsRead = { readonly rows: IndexedSymbolRows } | { readonly unavailable: string };

/** The graph reads the hydration needs — the pool's cold-start pair. */
export type IndexedSymbolRowsGraphDb = Pick<GraphDbClient, "listAllSymbols" | "listFileContentHashes">;

/**
 * Reads the index's definitions and file set. `undefined` graph (no codegraph
 * database), a failed read, or a graph holding no file all answer
 * `unavailable` with the cause: an empty table would read as "the project
 * holds nothing" and silently drop every table-resolved edge.
 */
export async function readIndexedSymbolRows(
  graphDb: IndexedSymbolRowsGraphDb | undefined,
): Promise<IndexedSymbolRowsRead> {
  if (graphDb === undefined) return { unavailable: "the collection has no codegraph database" };
  try {
    const [definitions, fileRows] = await Promise.all([graphDb.listAllSymbols(), graphDb.listFileContentHashes()]);
    if (fileRows.length === 0) return { unavailable: "the codegraph database holds no file — the index is not built" };
    return { rows: { definitions, files: fileRows.map((row) => row.relPath) } };
  } catch (error) {
    return {
      unavailable: `reading the indexed symbol table failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The working tree a review's table is overlaid with. */
export interface ReviewSymbolTableTreeOverlay {
  workTree: string;
  /** Every path the change touches (`DiffScopeRead.touchedFiles`). */
  touchedFiles: ReadonlySet<string>;
  /** The reviewed files as the tree holds them — their definitions replace the index's. */
  treeExtractions: readonly FileExtraction[];
  /**
   * Touched files as the diff BASE held them (bd tea-rags-mcp-slsia), each
   * extraction carrying the TREE path its base blob became — their definitions
   * replace the tree's. Only the base side's second read passes them: a base
   * text naming a constant the change renamed resolves to the file that
   * defined it at the base.
   */
  baseExtractions?: readonly FileExtraction[];
}

/** The index's rows hydrated into a fresh table, the working tree overlaid on it. */
export function buildReviewSymbolTable(
  rows: IndexedSymbolRows,
  overlay: ReviewSymbolTableTreeOverlay,
): GlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.hydrate([...rows.definitions]);
  table.hydrateFiles(rows.files);
  for (const relPath of overlay.touchedFiles) {
    if (!existsSync(join(overlay.workTree, relPath))) table.removeFile(relPath);
    else if (isCodegraphPath(relPath)) table.hydrateFiles([relPath]);
  }
  for (const extraction of [...overlay.treeExtractions, ...(overlay.baseExtractions ?? [])]) {
    table.upsertFile(extraction.relPath, symbolDefinitionsOf(extraction));
  }
  return table;
}

/** Whether a codegraph language walks this path — the index's file table holds no other. */
function isCodegraphPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  return dot !== -1 && CODEGRAPH_LANGUAGE_BY_EXTENSION[relPath.slice(dot)] !== undefined;
}
