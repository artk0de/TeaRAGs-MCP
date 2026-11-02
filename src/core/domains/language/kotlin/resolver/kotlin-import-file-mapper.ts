/**
 * Which project file a Kotlin import names.
 *
 * `com.acme.Repo` and `com.acme.Repo.save` synthesise `com/acme/Repo.kt` (and
 * `.kts`) relative to a source root. The symbol table decides whether a
 * project file ends in that path — never the disk. A wildcard, a class-less
 * import, an empty table, two matching files, or a name the index does not
 * hold is `unknown`. An import that is not in the index does not become
 * `external`.
 */

import type { CallContext, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";

const UNKNOWN: ImportFileTarget = { kind: "unknown" };
const EXTENSIONS = [".kt", ".kts"] as const;

interface KotlinImportPath {
  readonly className: string;
  readonly pathNoExt: string;
}

/** Path relative to a source root, without an extension. Null when the import names no type. */
export function mapKotlinImportToPath(importText: string): KotlinImportPath | null {
  if (importText.endsWith(".*")) return null;
  const segments = importText.split(".");
  let classIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    if (segment.length > 0 && segment[0] >= "A" && segment[0] <= "Z") {
      classIdx = i;
      break;
    }
  }
  if (classIdx === -1) return null;
  const className = segments[classIdx] ?? "";
  return { className, pathNoExt: segments.slice(0, classIdx + 1).join("/") };
}

export class KotlinImportFileMapper implements ImportFileMapper {
  mapImportToFile(importText: string, _fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const parsed = mapKotlinImportToPath(importText);
    if (parsed === null || ctx.symbolTable.size() === 0) return UNKNOWN;
    const files = new Set<RelPath>();
    for (const ext of EXTENSIONS) {
      const relPath = `${parsed.pathNoExt}${ext}`;
      if (ctx.symbolTable.hasFile(relPath)) files.add(relPath);
    }
    const suffixes = EXTENSIONS.map((ext) => `/${parsed.pathNoExt}${ext}`);
    for (const def of ctx.symbolTable.lookupByShortName(parsed.className)) {
      if (suffixes.some((suffix) => def.relPath.endsWith(suffix))) files.add(def.relPath);
    }
    if (files.size === 1) return { kind: "project", relPath: [...files][0] };
    return UNKNOWN;
  }
}
