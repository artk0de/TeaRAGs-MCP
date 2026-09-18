/**
 * Import → file-edge construction, shared by every language whose file graph is
 * explicit imports (bd tea-rags-mcp-9fgdi, E2 seam 1).
 *
 * Replaces `defaultImportFileEdges`'s fake-call trick
 * (`trajectory/codegraph/symbols/resolution-runner.ts`) for languages that
 * supply an `ImportFileMapper`: instead of synthesising a call per import
 * and reading whatever the resolver chain happens to commit, ask the mapper
 * directly. The chain answers "what does this CALL reach"; a file edge asks
 * "what does this IMPORT name" — different questions that only accidentally
 * shared an implementation.
 *
 * Deliberately without judgement. Root inference, `.py` vs `__init__.py`,
 * stdlib membership, namespace packages — all of that belongs to the mapper.
 * What lives here is the part every language agrees on.
 */

import type { CallContext, FileExtraction, GraphEdges } from "../../contracts/types/codegraph.js";
import type { ImportFileMapper } from "../../contracts/types/language.js";

export function resolveImportFileEdges(
  extraction: FileExtraction,
  mapper: ImportFileMapper,
  ctx: CallContext,
): GraphEdges["fileEdges"] {
  const fileEdges: GraphEdges["fileEdges"] = [];
  for (const imp of extraction.imports) {
    const target = mapper.mapImportToFile(imp.importText, extraction.relPath, ctx);
    // `external` and `unknown` both produce nothing. An external module has no
    // row in `cg_symbols_files` to point at, and an unknown one would be the
    // phantom this seam exists to remove.
    if (target.kind !== "project") continue;
    // A package `__init__.py` doing `from . import x` maps to itself. A
    // self-edge is a real row in `cg_symbols_edges_file` and would count into
    // the file's own fanIn and fanOut.
    if (target.relPath === extraction.relPath) continue;
    fileEdges.push({
      targetRelPath: target.relPath,
      importText: imp.importText,
    });
  }
  // NOT deduped here. `CallEdgeResolutionRunner#buildFileEdges` applies
  // `dedupeFileEdgesByTarget` to whatever either branch returns, because the
  // uniqueness is a property of the persisted EDGE, not of any one language's
  // import loop.
  return fileEdges;
}
