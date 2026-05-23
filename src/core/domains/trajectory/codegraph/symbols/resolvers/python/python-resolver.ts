/**
 * Python implementation of the `CallResolver` contract.
 *
 * Resolution strategy mirrors TSCallResolver:
 *   0. Local binding: if `ctx.localBindings[receiver]` carries a known
 *      type name, resolve `<type>.<member>` against the symbol table.
 *      When the type's import resolves to a file but the method is not
 *      defined there, DROP the edge — never fall through to the global
 *      short-name path, which is exactly the source of the ugnest false
 *      positive (`serializer.is_valid()` attributed to `ConfirmationCode`).
 *   1. With a receiver: find the `import` whose last module segment
 *      matches the receiver name; map the module path to a file via
 *      `mapPythonImportToFile`; then look up the member in the symbol
 *      table restricted to that file.
 *   2. Without a receiver: fall back to a global short-name lookup —
 *      handles bare top-level function calls.
 *   3. If neither resolves, return null.
 *
 * Python's syntax differs from TS in import style (`from foo import
 * bar`), so the "receiver matches an import" check needs to also
 * consider import names imported via `from X import Y` — Y becomes a
 * locally-bound name even though X is the module file. This is
 * pragmatically handled by accepting both `importText` (module path)
 * AND the final segment as the receiver match.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../../../contracts/types/codegraph.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";

export class PythonCallResolver implements CallResolver {
  readonly language = "python";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // bd tea-rags-mcp-pic4 — `super().method()` walks `classExtends` from
    // the enclosing class to its parent and resolves `<Parent>#<member>`
    // / `<Parent>.<member>` against the symbol table. Without this branch
    // the call would fall through to short-name fallback, which is
    // ambiguous when multiple classes share the same `__init__` /
    // `method` short-name. Mirrors the TS resolver's `resolveSuper`.
    if (call.receiver === "super()" || call.receiver === "super") {
      return this.resolveSuper(call.member, ctx);
    }
    if (call.receiver) {
      // Step 0: walker-inferred local type wins over heuristic
      // resolution. When the receiver maps to a known class via
      // `var = ClassName(...)`, `var: ClassName`, or `def f(var: Cls)`,
      // resolution is constrained to that class — if the method isn't
      // defined on that class, the edge is dropped rather than guessed.
      const localType = ctx.localBindings?.[call.receiver];
      if (localType) {
        const localTarget = this.resolveByLocalType(localType, call.member, ctx);
        // `null` means "we know the type but cannot pin the method to
        // its file" — DROP, do not fall through to the heuristic paths.
        return localTarget;
      }
      const match = ctx.imports.find((imp) => pythonImportMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapPythonImportToFile(match.importText, ctx.callerFile);
        if (targetFile) {
          const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }

  /**
   * Resolve a `super().X()` call against the parent class determined by
   * `ctx.classExtends`. Walks the single-inheritance chain (B extends A,
   * A extends C, …) until an ancestor's file owns a symbol matching
   * `member`. Returns:
   *
   *   - `{ relPath, symbolId }` when an ancestor in the chain has the
   *     method — instance form preferred, static fallback.
   *   - `null` when the enclosing class is unknown, the parent chain is
   *     empty, or no ancestor in the project defines `member`.
   *
   * Mirrors `TSCallResolver.resolveSuper` (bd tea-rags-mcp-4rgg) with
   * single-inheritance Python semantics.
   */
  private resolveSuper(member: string, ctx: CallContext): ResolvedTarget | null {
    if (ctx.callerScope.length === 0) return null;
    if (!ctx.classExtends) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    const visited = new Set<string>([enclosing]);
    while (current && !visited.has(current)) {
      visited.add(current);
      // Instance form first — `super().__init__()` is an instance-method
      // dispatch by definition. Static fallback covers the unusual
      // `super().classmethod()` shape (legal Python but rare).
      const instanceFq = `${current}#${member}`;
      const instanceHit = ctx.symbolTable.lookup(instanceFq);
      const instanceTarget = pickSingleCandidate(instanceHit, this.mode);
      if (instanceTarget) {
        return { targetRelPath: instanceTarget.relPath, targetSymbolId: instanceTarget.symbolId };
      }
      const staticFq = `${current}.${member}`;
      const staticHit = ctx.symbolTable.lookup(staticFq);
      const staticTarget = pickSingleCandidate(staticHit, this.mode);
      if (staticTarget) {
        return { targetRelPath: staticTarget.relPath, targetSymbolId: staticTarget.symbolId };
      }
      // Walk one step deeper.
      current = ctx.classExtends[current];
    }
    return null;
  }

  /**
   * Look up `<typeName>.<member>` from the walker's local-binding
   * inference. Strategy:
   *   1. Resolve `typeName` to a file via the receiver-matches-import
   *      check on the bare class name (last segment for qualified
   *      types like `module.ClassName`).
   *   2. Within that file's symbols, look for `<member>` as a method.
   *   3. If the type's import isn't found, broaden: look for ANY
   *      symbol in the table whose shortName matches the bare type
   *      name AND has scope ending in that type — the symbol file
   *      becomes the target.
   *   4. If the target file is identified but `<member>` is not in
   *      it, return a partial edge (file-only) so the file-level fan
   *      remains accurate even when the method is inherited from a
   *      base class outside the project (DRF `is_valid` on
   *      `Serializer`).
   *   5. Return `null` only when even the type's file is unknown.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): ResolvedTarget | null {
    // Bare class — `ToggleReactionSerializer`. Resolve via the import
    // list: walker either imported the class directly (`from x import
    // ToggleReactionSerializer`) or as a module path that ends in the
    // class name (rare).
    const bareType = lastSegment(typeName);
    const targetFile = resolveTypeFile(bareType, ctx);
    if (!targetFile) return null;

    const candidates = ctx.symbolTable
      .lookupByShortName(member)
      .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
    const target = pickSingleCandidate(candidates, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    // The class itself lives in `targetFile` but `member` is inherited
    // or defined elsewhere — record the file-level attribution so the
    // file-edge stays accurate; drop the method-level edge by passing
    // a null symbol id.
    return { targetRelPath: targetFile, targetSymbolId: null };
  }
}

/**
 * Find the file path of a bare class name by walking the import list.
 * Two shapes match:
 *   - `from <module> import <Bare>` — importText is `<module>`; the
 *     class name appears in the symbol table at the file `<module>`
 *     resolves to.
 *   - `import <module>` where `<module>` ends in the bare type name.
 *
 * Returns the file path of the class definition when an import
 * resolves there, or `null` otherwise.
 */
function resolveTypeFile(bareType: string, ctx: CallContext): string | null {
  // First pass: scan symbol table for ANY definition matching the
  // bare type name. If it's unique we have the file directly.
  const tableMatches = ctx.symbolTable.lookupByShortName(bareType);
  if (tableMatches.length === 1) return tableMatches[0].relPath;

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports.
  if (tableMatches.length > 1) {
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
      if (file) importedFiles.add(file);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // Still ambiguous — refuse to guess.
    return null;
  }

  // Third pass: bare type not in symbol table (defined outside the
  // project — e.g. DRF Serializer). Walk imports: if any import path
  // ends in the type name and resolves to a file, attribute to that.
  for (const imp of ctx.imports) {
    if (lastSegment(imp.importText) !== bareType) continue;
    const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
    if (file) return file;
  }
  return null;
}

function lastSegment(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] ?? qualified;
}

function pythonImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip leading dots (relative-import marker) for the comparison —
  // `..foo.bar` should still match `bar` as a receiver. Compare
  // case-sensitively: Python is case-sensitive (User != user).
  const cleaned = importText.replace(/^\.+/, "");
  const segments = cleaned.split(".").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
