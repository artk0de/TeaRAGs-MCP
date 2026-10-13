/**
 * The two import channels of one file extraction, as the views the file-edge
 * resolution runs over (bd tea-rags-mcp-c9a40). A file's imports split into
 * RUNTIME ones (they load code) and TYPE-ONLY ones (TS `import type` /
 * `export type … from`, walker `typeOnlyImports`; an `imports[]` entry flagged
 * `typeOnly`, e.g. Python `if TYPE_CHECKING:`). Each view is the extraction
 * with `imports` narrowed to one channel, so the same import→file resolver
 * maps a specifier to the same file whichever channel carries it.
 *
 * Shared by `CallEdgeResolutionRunner` (the index) and the review_changes
 * working-tree overlay, so the overlay reads the same file graph the index
 * persists — since bd tea-rags-mcp-89k7k.31 type-only edges join
 * `cg_symbols_edges_file`.
 */

import type { FileExtraction } from "../../../../contracts/types/codegraph.js";

/**
 * The extraction the RUNTIME file graph resolves over: imports flagged
 * `typeOnly` removed. The same object comes back when nothing is flagged — the
 * common case, and the only one for a language that derives file edges from
 * more than its imports.
 */
export function runtimeImportExtraction(extraction: FileExtraction): FileExtraction {
  return extraction.imports.some((imp) => imp.typeOnly)
    ? { ...extraction, imports: extraction.imports.filter((imp) => !imp.typeOnly) }
    : extraction;
}

/**
 * The extraction the TYPE-ONLY file graph resolves over: every `imports[]`
 * entry flagged `typeOnly` plus the `typeOnlyImports` channel, as its
 * `imports`. `undefined` when the file has no type-only import.
 */
export function typeOnlyImportExtraction(extraction: FileExtraction): FileExtraction | undefined {
  const typeOnlyImports = [...extraction.imports.filter((imp) => imp.typeOnly), ...(extraction.typeOnlyImports ?? [])];
  if (typeOnlyImports.length === 0) return undefined;
  return { ...extraction, imports: typeOnlyImports };
}
