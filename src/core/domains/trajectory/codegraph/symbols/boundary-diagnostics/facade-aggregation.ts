import { exposedReexportNames } from "../../../../../contracts/reexport-bindings.js";
import type { FileDependencyEdge } from "../../../../../contracts/types/codegraph.js";
import { MODULE_ENTRY_FILE_NAMES } from "../../component-geometry/index.js";

/**
 * What the facade-aggregation exclusion catches, named for a report
 * (bd tea-rags-mcp-r8hme.6).
 */
export const FACADE_AGGREGATION_REASON =
  "facade aggregation: a module facade re-exporting a descendant module's facade";

const ENTRY_FILE_NAMES: ReadonlySet<string> = new Set(Object.values(MODULE_ENTRY_FILE_NAMES).flat());

/** Entry files whose imports ARE the package's exports — Python has no re-export syntax. */
const IMPORTS_ARE_EXPORTS_ENTRY_NAMES: ReadonlySet<string> = new Set(MODULE_ENTRY_FILE_NAMES.python);

/**
 * The edge is a module facade exposing the facade of a module nested inside it:
 * both endpoints are entry files ({@link MODULE_ENTRY_FILE_NAMES}), the target's
 * directory lies strictly below the source's, and the edge carries a re-export
 * — or, from a Python `__init__.py`, any recorded import, since there the
 * imports are the exports.
 *
 * That is aggregation, not a dependency in Martin's sense: the child module is
 * part of the parent's surface, and the parent facade's instability describes
 * that surface, not code that relies on the child. An edge whose facade only
 * IMPORTS from the child (for code of its own) is a dependency and stays
 * judged; so is an edge with no recorded names, which cannot show a re-export.
 */
export function isFacadeAggregationEdge(edge: FileDependencyEdge): boolean {
  const sourceName = baseName(edge.sourceRelPath);
  if (!ENTRY_FILE_NAMES.has(sourceName) || !ENTRY_FILE_NAMES.has(baseName(edge.targetRelPath))) return false;
  const sourceDir = directoryOf(edge.sourceRelPath);
  const targetDir = directoryOf(edge.targetRelPath);
  const descendant = sourceDir === "" ? targetDir !== "" : targetDir.startsWith(`${sourceDir}/`);
  return descendant && carriesReexport(edge);
}

/**
 * The edge forwards the target's exports as the source's own: it records a
 * re-export (`export … from`), or it leaves a Python `__init__.py`, where the
 * imports are the exports. An edge with no recorded names cannot show one.
 */
export function carriesReexport(edge: FileDependencyEdge): boolean {
  return forwardedExportNames(edge).length > 0;
}

/**
 * The names the edge forwards, in the spelling an importer of the SOURCE
 * writes (`*` for a whole-module re-export): its exposed re-export names —
 * the alias of `export { a as b }` (bd tea-rags-mcp-zl3so), whose target name
 * `reexportSourceName` gives back — or a Python `__init__.py`'s imported
 * names. Empty when the edge forwards nothing it recorded.
 */
export function forwardedExportNames(edge: FileDependencyEdge): readonly string[] {
  const exposed = exposedReexportNames(edge) ?? [];
  if (exposed.length > 0) return exposed;
  return IMPORTS_ARE_EXPORTS_ENTRY_NAMES.has(baseName(edge.sourceRelPath)) ? (edge.importedExportNames ?? []) : [];
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}
