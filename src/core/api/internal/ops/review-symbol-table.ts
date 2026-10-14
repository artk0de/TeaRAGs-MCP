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

/**
 * The indexed rows held across reviews by the long-lived process (bd
 * tea-rags-mcp-nehn5): DDG reviews per commit from one MCP server, and the
 * whole-table read is the review's most expensive graph read (taxdome: 98k
 * definitions, a 39 MB daemon frame). An entry is keyed by the database's
 * write stamp (`GraphDbClientPool#databaseWriteStamp`), which moves on every
 * committed write — an index run, a recompute, a checkpoint — so a cached
 * read is never older than the database. One entry per collection: a new
 * stamp replaces the old rows. Only `rows` answers stay; an unavailable read
 * is retried by the next review, and no stamp means no caching.
 */
export class IndexedSymbolRowsCache {
  private readonly entries = new Map<string, { stamp: string; read: Promise<IndexedSymbolRowsRead> }>();

  /**
   * The rows of `collectionName`'s database. `stampOf` is called BEFORE the
   * read, so a write that commits while the rows are in flight leaves the
   * entry under the older stamp and the next review reads again.
   */
  async read(
    collectionName: string,
    stampOf: () => string | undefined,
    graphDb: IndexedSymbolRowsGraphDb | undefined,
  ): Promise<IndexedSymbolRowsRead> {
    const stamp = graphDb === undefined ? undefined : stampOf();
    if (stamp === undefined) return readIndexedSymbolRows(graphDb);
    const entry = this.entries.get(collectionName);
    if (entry?.stamp === stamp) return entry.read;
    const read = readIndexedSymbolRows(graphDb);
    this.entries.set(collectionName, { stamp, read });
    const answer = await read;
    if (!("rows" in answer) && this.entries.get(collectionName)?.read === read) this.entries.delete(collectionName);
    return answer;
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
