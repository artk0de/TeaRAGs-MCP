import type { CallContext, RelPath, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { lookupPythonSymbolsByShortName } from "./strategies/shared.js";

/**
 * A dotted spelling as ANOTHER file's module scope sees it — that file's own
 * declarations and `from` imports, never the caller's (bd tea-rags-mcp-pbwd,
 * shared with the P2 callable-value flow, bd tea-rags-mcp-m99j1.1.19).
 *
 *   - `name` — declared at module level in `file`, or one re-export walk on
 *     (`resolveExportedName` over `file`'s own `from` statements);
 *   - `Cls.member` — a member of a class reached that way;
 *   - `module.name` — `name` in a module `file` bound by a `from` import
 *     (`resolveExportedModule`).
 *
 * A longer dotted spelling, or a head bound by a plain `import`, answers
 * `null`; so does any lookup that is not unique.
 */
export function resolvePythonModuleScopeSpelling(
  spelling: string,
  file: RelPath,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): SymbolResolutionTarget | null {
  const dot = spelling.lastIndexOf(".");
  const receiver = dot === -1 ? null : spelling.slice(0, dot);
  const member = dot === -1 ? spelling : spelling.slice(dot + 1);
  if (receiver === null) return declaredAtModuleLevel(member, file, ctx, mapper);
  if (receiver.includes(".")) return null;
  const cls = declaredAtModuleLevel(receiver, file, ctx, mapper);
  if (cls) {
    const members = lookupPythonSymbolsByShortName(ctx, member, { role: "callee" }).filter(
      (d) => d.relPath === cls.targetRelPath && d.scope.length === 1 && d.scope[0] === receiver,
    );
    return members.length === 1 ? { targetRelPath: members[0].relPath, targetSymbolId: members[0].symbolId } : null;
  }
  // `module.fn` — the head is a module the file imported by name.
  const moduleFile = mapper.resolveExportedModule(file, receiver, ctx);
  return moduleFile === null ? null : declaredAtModuleLevel(member, moduleFile, ctx, mapper);
}

/** `name` as `file` sees it: declared there, or re-exported into it. */
function declaredAtModuleLevel(
  name: string,
  file: RelPath,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): SymbolResolutionTarget | null {
  const declaringFile = mapper.resolveExportedName(file, name, ctx) ?? file;
  const defs = lookupPythonSymbolsByShortName(ctx, name).filter(
    (d) => d.relPath === declaringFile && d.scope.length === 0,
  );
  return defs.length === 1 ? { targetRelPath: defs[0].relPath, targetSymbolId: defs[0].symbolId } : null;
}
