/**
 * `JavaImportFileMapper` — which project file a Java import names (bd
 * tea-rags-mcp-vfmfg).
 *
 * `mapJavaImportToFile` turns `com.foo.Bar` into `com/foo/Bar.java` from the
 * import text alone. That path names a real file only when the project keeps
 * its sources at the repository root; in a Maven / Gradle layout the file is
 * `src/main/java/com/foo/Bar.java`, and for a JDK or library import
 * (`java.util.Objects`) no project file exists at all. Both were emitted as edge
 * targets, so on commons-lang 1079 of 1116 Java file edges named no file.
 *
 * A fully-qualified import names exactly one path below SOME source root, so
 * the question this mapper answers is "which file of the index ends in that
 * path". It asks the symbol table, never the disk (the `ImportFileMapper`
 * contract): the candidate files are those declaring the imported class's
 * short name, kept when their path ends at a segment boundary in the
 * synthesised one — `src/main/java/com/app/Objects.java` does not answer
 * `java.util.Objects`.
 *
 *   - one such file  → `project`
 *   - none, table populated → `external`: a fully-qualified import the index
 *     holds no file for leaves the project
 *   - two or more (the same class under two source roots), a wildcard or
 *     class-less import, or an empty table → `unknown`
 */

import type { CallContext, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";

const EXTERNAL: ImportFileTarget = { kind: "external" };
const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/**
 * The path a fully-qualified import names relative to its source root, from
 * the text alone — `com.foo.Bar` and `com.foo.Bar.helper` → `com/foo/Bar.java`.
 * `null` for a wildcard (a package, not a file) or a class-less text. NOT a
 * project file: {@link JavaImportFileMapper} decides that.
 */
export function mapJavaImportToFile(importText: string): string | null {
  // Strip wildcards — they point at directories, not specific files.
  if (importText.endsWith(".*")) return null;
  // Static import: drop trailing `.methodName` (the part after the
  // last segment whose first letter is uppercase signifies the class).
  const segments = importText.split(".");
  // Find the class segment (first uppercase-leading segment).
  let classIdx = -1;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    if (s.length > 0 && s[0] >= "A" && s[0] <= "Z") {
      classIdx = i;
      break;
    }
  }
  if (classIdx === -1) return null;
  const pathSegments = segments.slice(0, classIdx + 1);
  return `${pathSegments.join("/")}.java`;
}

export class JavaImportFileMapper implements ImportFileMapper {
  mapImportToFile(importText: string, _fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const synthesised = mapJavaImportToFile(importText);
    if (synthesised === null) return UNKNOWN;
    if (ctx.symbolTable.size() === 0) return UNKNOWN;
    if (ctx.symbolTable.hasFile(synthesised)) return { kind: "project", relPath: synthesised };
    const className = synthesised.slice(synthesised.lastIndexOf("/") + 1, -".java".length);
    const suffix = `/${synthesised}`;
    const files = new Set<RelPath>();
    for (const def of ctx.symbolTable.lookupByShortName(className)) {
      if (def.relPath.endsWith(suffix)) files.add(def.relPath);
    }
    if (files.size === 1) return { kind: "project", relPath: [...files][0] };
    return files.size === 0 ? EXTERNAL : UNKNOWN;
  }
}
