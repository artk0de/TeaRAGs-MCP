/**
 * FileImportOps — file-scope `get_callers` / `get_callees` (bd tea-rags-mcp-gfvr8).
 *
 * Given a FILE instead of a symbol, "who calls it" is answered by the file edge
 * table: the files importing it, and symmetrically the files it imports. Both
 * are one `cg_symbols_edges_file` read through the collection's graph handle;
 * this class only shapes the rows — the other endpoint of each edge, heaviest
 * call weight first, `limit` applied after ordering — and turns "the graph has
 * no such file" into a message instead of a bare empty list, which would read
 * as "nothing imports it".
 */

import type { FileImportEdge, GraphDbClient, RelPath } from "../../../contracts/types/codegraph.js";
import type { FileImportersResponse, FileImportResult, FileImportsResponse } from "../../public/dto/graph.js";

type FileImportReader = Pick<GraphDbClient, "getFileImporters" | "getFileImports">;

/** A caller-supplied repo-relative path, with a leading `./` (any count) dropped. */
export function normalizeRelativePath(relativePath: string): RelPath {
  return relativePath.replace(/^(?:\.\/)+/, "");
}

export class FileImportOps {
  async importers(graphDb: FileImportReader, relativePath: RelPath, limit: number): Promise<FileImportersResponse> {
    const lookup = await graphDb.getFileImporters(relativePath);
    const { results, total, message } = shape(
      lookup.edges,
      (e) => e.sourceRelPath,
      lookup.fileKnown,
      relativePath,
      limit,
    );
    return { relativePath, importers: results, total, ...(message ? { message } : {}) };
  }

  async imports(graphDb: FileImportReader, relativePath: RelPath, limit: number): Promise<FileImportsResponse> {
    const lookup = await graphDb.getFileImports(relativePath);
    const { results, total, message } = shape(
      lookup.edges,
      (e) => e.targetRelPath,
      lookup.fileKnown,
      relativePath,
      limit,
    );
    return { relativePath, imports: results, total, ...(message ? { message } : {}) };
  }

  /** The answer for a collection with no graph database: nothing indexed, nothing to report. */
  static emptyImporters(relativePath: RelPath): FileImportersResponse {
    return { relativePath, importers: [], total: 0 };
  }

  static emptyImports(relativePath: RelPath): FileImportsResponse {
    return { relativePath, imports: [], total: 0 };
  }
}

function shape(
  edges: readonly FileImportEdge[],
  otherEnd: (e: FileImportEdge) => RelPath,
  fileKnown: boolean,
  relativePath: RelPath,
  limit: number,
): { results: FileImportResult[]; total: number; message?: string } {
  const results = edges
    .map((e) => ({ relativePath: otherEnd(e), importText: e.importText, callWeight: e.callWeight }))
    .sort((a, b) => b.callWeight - a.callWeight || a.relativePath.localeCompare(b.relativePath));
  const message =
    !fileKnown && edges.length === 0
      ? `No codegraph file matches relativePath "${relativePath}". Pass a repo-relative path ` +
        "(e.g. src/app.ts — no absolute path) of a file in a language the codegraph walks."
      : undefined;
  return { results: results.slice(0, limit), total: results.length, message };
}
