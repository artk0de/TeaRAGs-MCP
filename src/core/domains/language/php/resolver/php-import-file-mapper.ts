/**
 * Which project file a PHP `use` names.
 *
 * `use Foo\Bar` synthesises `Foo/Bar.php` only as a suffix to test against the
 * symbol table. The table is the index: nothing here reads the disk. A use
 * the index does not hold is `unknown` — an empty table, two files, or no
 * file — and that answer carries no path. PHP has no stdlib prefix that would
 * make absence a positive out-of-project verdict, so this mapper does not
 * return `external`.
 */

import type { CallContext, RelPath, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { ImportFileMapper, ImportFileTarget } from "../../../../contracts/types/language.js";

const UNKNOWN: ImportFileTarget = { kind: "unknown" };

/** `Foo\Bar` → `Foo/Bar.php`, from the text alone. Not a project file. */
export function phpImportSuffix(importText: string): string | null {
  const trimmed = importText.replace(/^\\+/, "").replace(/\\+$/, "");
  if (trimmed === "" || trimmed.includes(" ")) return null;
  const segments = trimmed.split("\\").filter((segment) => segment !== "");
  if (segments.length === 0) return null;
  return `${segments.join("/")}.php`;
}

function isPhpTypeSymbol(def: SymbolDefinition): boolean {
  if (def.symbolKind === "class" || def.symbolKind === "interface" || def.symbolKind === "enum") return true;
  if (def.symbolKind !== undefined) return false;
  return !def.symbolId.includes("#") && !def.symbolId.includes(".");
}

export class PhpImportFileMapper implements ImportFileMapper {
  mapImportToFile(importText: string, _fromFile: RelPath, ctx: CallContext): ImportFileTarget {
    const suffix = phpImportSuffix(importText);
    if (suffix === null || ctx.symbolTable.size() === 0) return UNKNOWN;
    if (ctx.symbolTable.hasFile(suffix)) return { kind: "project", relPath: suffix };
    const className = suffix.slice(suffix.lastIndexOf("/") + 1, -".php".length);
    const files = new Set<RelPath>();
    for (const def of ctx.symbolTable.lookupByShortName(className)) {
      if (!isPhpTypeSymbol(def)) continue;
      if (def.relPath === suffix || def.relPath.endsWith(`/${suffix}`)) files.add(def.relPath);
    }
    const [file] = files;
    if (files.size === 1 && file !== undefined) return { kind: "project", relPath: file };
    return UNKNOWN;
  }
}
