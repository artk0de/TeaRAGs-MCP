import type { FileDependencyEdge } from "../../../../../contracts/types/codegraph.js";
import { MODULE_ENTRY_FILE_NAMES } from "./leaking-abstraction.js";

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
  if (!descendant) return false;
  if ((edge.reexportedExportNames?.length ?? 0) > 0) return true;
  return IMPORTS_ARE_EXPORTS_ENTRY_NAMES.has(sourceName) && (edge.importedExportNames?.length ?? 0) > 0;
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}
