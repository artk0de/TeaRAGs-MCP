/**
 * TypeScript implementation of the `CallResolver` contract.
 *
 * Resolution strategy:
 *   1. `super(...)` / `super.X()` — walk `ctx.classExtends` from the
 *      enclosing class to find the parent, then look up
 *      `<Parent>#<member>` in the parent's file. Without classExtends
 *      data the call cannot resolve safely — returning the enclosing
 *      class's own method would emit a self-loop edge (bd
 *      `tea-rags-mcp-4rgg`), so we return null instead.
 *   2. `this.X()` — look up `<enclosingClass>#X` / `<enclosingClass>.X`
 *      in the caller's own file, where `enclosingClass` is the last
 *      segment of `ctx.callerScope`. Captures intra-class calls that
 *      would otherwise be dropped (`this` has no entry in `ctx.imports`).
 *   3. If the call has a receiver, look it up in `ctx.imports`. If matched,
 *      `mapImportToFile` resolves the path; then `lookupByShortName(member)`
 *      restricted to that target file gives the symbolId.
 *   4. Fall back to a global `lookupByShortName(member)` — handles default
 *      exports, ambient declarations, and free calls.
 *   5. If none resolves, return `null` (orphan calls are dropped by the
 *      provider; recording an edge with `targetSymbolId: null` only when the
 *      target file is known).
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
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";

export class TSCallResolver implements CallResolver {
  readonly language = "typescript";

  constructor(
    private readonly tsOptions: TsCompilerOptions,
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    // `super(...)` / `super.X()` — walk to the PARENT class via
    // `classExtends`, then resolve `<Parent>#<member>`. Without
    // classExtends data we cannot know the parent and MUST return
    // null rather than fall through to same-file lookup — that path
    // would route back to the enclosing class's own method and emit
    // a self-loop edge (bd `tea-rags-mcp-4rgg`). Mirrors Ruby's
    // `RubyCallResolver.resolveSuper` walk pattern with single
    // inheritance.
    if (call.receiver === "super") {
      return this.resolveSuper(call.member, ctx);
    }
    // Intra-class `this.X()` — same-file lookup of `<EnclosingClass>#X`.
    // Both `#` (instance) and `.` (static) forms are checked because
    // `this.staticHelper` is unusual but legal. Per the project
    // convention (`.claude/rules/symbolid-convention.md`).
    if (call.receiver === "this") {
      if (ctx.callerScope.length > 0) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const fqName = `${enclosing}#${call.member}`;
        const direct = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
        if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
        // Static dispatch within the class — `this.staticHelper` is
        // unusual but legal; the target symbolId then uses `.`.
        const staticFqName = `${enclosing}.${call.member}`;
        const staticHit = ctx.symbolTable.lookup(staticFqName).find((def) => def.relPath === ctx.callerFile);
        if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
        // Class instance shadowed via getter / decorator / mixin: fall
        // back to short-name lookup within the same file, which still
        // beats global ambiguity.
        const sameFile = ctx.symbolTable.lookupByShortName(call.member).find((def) => def.relPath === ctx.callerFile);
        if (sameFile) return { targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId };
      }
    }
    // Cross-class via field access — `this.<field>.<method>()`. Look up
    // the field's declared type in `classFieldTypes` and resolve the
    // method against that type in the global symbol table. Tries the
    // `#` (instance) form first, then falls back to `.` (static).
    if (call.receiver && call.receiver.startsWith("this.") && ctx.callerScope.length > 0) {
      const fieldSegment = call.receiver.slice("this.".length);
      // Only one level of access supported — `this.foo.bar()` resolves.
      // `this.foo.bar.baz()` (chained) would need recursive type inference,
      // out of scope for slice 1.
      if (!fieldSegment.includes(".")) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
        if (typeName) {
          // Instance form first — most common dispatch shape. Strict
          // mode drops the edge when more than one type shares the
          // method name across files; legacy `first` mode keeps the
          // first hit.
          const instanceCandidates = ctx.symbolTable.lookup(`${typeName}#${call.member}`);
          const instanceHit = pickSingleCandidate(instanceCandidates, this.mode);
          if (instanceHit) {
            return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
          }
          // Static fallback — `this.helper.staticMethod()` shape.
          const staticCandidates = ctx.symbolTable.lookup(`${typeName}.${call.member}`);
          const staticHit = pickSingleCandidate(staticCandidates, this.mode);
          if (staticHit) {
            return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
          }
        }
      }
    }
    if (call.receiver) {
      // First pass: basename-normalized compare. Catches the common
      // kebab-case → PascalCase TS naming convention (`rank-module.js`
      // → `RankModule`) by stripping extensions and non-alphanumeric
      // characters before case-folded equality (bd tea-rags-mcp-kiuw).
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapImportToFile(match.importText, ctx.callerFile, this.tsOptions);
        if (targetFile) {
          const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath === targetFile);
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
      // Second pass: symbol-table FQN narrowing (bd tea-rags-mcp-kiuw).
      // When basename normalize fails (filename unrelated to class
      // name, multi-export file, arbitrary aliasing), discover the
      // owning file by treating the receiver itself as a symbol.
      // For each imported file, check if any definition with
      // `fqName === receiver` lives there. The intersection picks the
      // single file that imports AND declares the receiver as a
      // top-level symbol. Then resolve `member` within that file.
      const receiverHits = ctx.symbolTable.lookup(call.receiver);
      if (receiverHits.length > 0) {
        const importedFiles = new Set<string>();
        for (const imp of ctx.imports) {
          const file = mapImportToFile(imp.importText, ctx.callerFile, this.tsOptions);
          if (file) importedFiles.add(file);
        }
        const receiverFiles = new Set<string>();
        for (const hit of receiverHits) {
          if (importedFiles.has(hit.relPath)) receiverFiles.add(hit.relPath);
        }
        if (receiverFiles.size === 1) {
          const targetFile = receiverFiles.values().next().value as string;
          const candidates = ctx.symbolTable
            .lookupByShortName(call.member)
            .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === call.receiver);
          const target = pickSingleCandidate(candidates, this.mode);
          if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
          // Method not indexed yet — file-only edge so fan-graph stays
          // accurate even when method-level pinning fails.
          return { targetRelPath: targetFile, targetSymbolId: null };
        }
      }
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const fallbackHit = pickSingleCandidate(fallback, this.mode);
    if (fallbackHit) return { targetRelPath: fallbackHit.relPath, targetSymbolId: fallbackHit.symbolId };
    // Imports-narrowed fallback (bd tea-rags-mcp-2qp6). Recovery for the
    // interface-dispatch shape `param.method()` where `param: SomeInterface`
    // — the walker has no parameter-type info, so global short-name lookup
    // sees every implementer and strict mode drops them all. The caller's
    // import list is the only signal available to bias toward the concrete
    // implementer this caller can reach. If exactly one ambiguous candidate's
    // file is in `ctx.imports`, resolve to it; otherwise ambiguity is real
    // and we still drop. Only engages when N>1 (so the N=1 fast path above
    // keeps current semantics) and only when imports could resolve.
    if (fallback.length > 1 && ctx.imports.length > 0) {
      const importedFiles = new Set<string>();
      for (const imp of ctx.imports) {
        const file = mapImportToFile(imp.importText, ctx.callerFile, this.tsOptions);
        if (file) importedFiles.add(file);
      }
      if (importedFiles.size > 0) {
        const narrowed = fallback.filter((def) => importedFiles.has(def.relPath));
        const narrowedHit = pickSingleCandidate(narrowed, this.mode);
        if (narrowedHit) return { targetRelPath: narrowedHit.relPath, targetSymbolId: narrowedHit.symbolId };
      }
    }
    return null;
  }

  /**
   * Resolve a `super(...)` / `super.X()` call against the PARENT class
   * determined by `ctx.classExtends`. Walks the single-inheritance chain
   * (B extends A, A extends C, ...) until an ancestor's file owns a
   * symbol matching `member`. Returns:
   *
   *   - `{ relPath, symbolId }` when an ancestor in the chain has the
   *     method (instance form preferred; static fallback) — that's the
   *     winning edge.
   *   - `{ relPath, targetSymbolId: null }` when an ancestor's file is
   *     known but no symbol matches (method comes from a deeper
   *     out-of-project class — file-level fan stays accurate).
   *   - `null` when the enclosing class is unknown to `classExtends`,
   *     when the parent chain leads only to external classes (not in
   *     the symbol table), or when `callerScope` is empty.
   *
   * The null path is the load-bearing fix for bd `tea-rags-mcp-4rgg` —
   * the previous resolver fell through to the same-file lookup of the
   * enclosing class's OWN constructor and emitted a self-loop edge.
   * Returning null means "no edge" rather than "wrong edge".
   *
   * `visited` defends against accidental cycles in `classExtends` data
   * (well-formed TS rejects circular extends, but the walker may emit
   * a cycle if the input is malformed — defensive guard).
   */
  private resolveSuper(member: string, ctx: CallContext): ResolvedTarget | null {
    if (ctx.callerScope.length === 0) return null;
    if (!ctx.classExtends) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    const visited = new Set<string>([enclosing]);
    let fileOnlyFallback: ResolvedTarget | null = null;
    while (current && !visited.has(current)) {
      visited.add(current);
      // Prefer the instance form (`#`) — `super(arg)` / `super.foo()`
      // are instance-method dispatches by definition. Static fallback
      // covers the unusual `super.staticHelper()` shape.
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
      // Method not found on `current` itself — remember the first
      // ancestor whose file IS known so we can emit a file-only edge
      // when the chain exhausts without a method-level hit. Mirrors
      // Ruby `resolveSuper`'s file-only fallback for out-of-project
      // parents (e.g. `extends EventEmitter` where the method lives
      // in node_modules outside the index).
      //
      // To find the ancestor's file, look for ANY symbol whose scope
      // ends with the ancestor's name (covers `Base`, `Base#foo`,
      // `Base.bar` — all carry `scope[-1] === "Base"`). The class
      // declaration itself also creates a top-level symbol whose
      // `shortName === current` (e.g. fqName `Base`).
      if (fileOnlyFallback === null) {
        const ancestorShort = lastSegment(current);
        const ancestorDef = ctx.symbolTable
          .lookupByShortName(ancestorShort)
          .find((def) => def.scope.length === 0 && def.shortName === ancestorShort);
        if (ancestorDef) {
          fileOnlyFallback = { targetRelPath: ancestorDef.relPath, targetSymbolId: null };
        } else {
          // Fall back to the file of any method whose scope is the
          // ancestor — covers files that only have method symbols
          // (the class declaration itself wasn't indexed as a top-level
          // symbol, only its methods).
          for (const def of ctx.symbolTable.lookupByShortName(member)) {
            if (def.scope[def.scope.length - 1] === current) {
              fileOnlyFallback = { targetRelPath: def.relPath, targetSymbolId: null };
              break;
            }
          }
          if (fileOnlyFallback === null) {
            // Last resort — scan for ANY symbol whose innermost scope is
            // `current`. Captures the case where the parent class has
            // arbitrary indexed members (constructor, fields, etc.)
            // but no match for `member` and no top-level Base symbol.
            const scopeProbe = ctx.symbolTable.lookupByShortName("constructor");
            for (const def of scopeProbe) {
              if (def.scope[def.scope.length - 1] === current) {
                fileOnlyFallback = { targetRelPath: def.relPath, targetSymbolId: null };
                break;
              }
            }
          }
        }
      }
      // Walk one step deeper. `classExtends` carries one parent per
      // class — single inheritance, no mixin chain to consider.
      current = ctx.classExtends[current];
    }
    return fileOnlyFallback;
  }
}

function lastSegment(qualified: string): string {
  // `A.B.C` → `C`. Used to look up the short-name of a qualified
  // parent class for the file-only fallback in `resolveSuper`.
  const dot = qualified.lastIndexOf(".");
  return dot === -1 ? qualified : qualified.slice(dot + 1);
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  // Match the basename of the import specifier against the receiver,
  // normalizing both sides so the common TS kebab-case → PascalCase
  // file/class naming convention resolves (bd tea-rags-mcp-kiuw).
  // Examples:
  //   "../rank-module.js" → basename "rank-module.js" → norm "rankmodule"
  //   "RankModule"                                    → norm "rankmodule"
  //   "./foo.ts"          → basename "foo.ts"         → norm "foo"
  //   "Foo"                                           → norm "foo"
  // Arbitrary-name cases (filename unrelated to class) are handled by
  // the symbol-table FQN fallback in the caller — this comparator
  // intentionally only catches the cheap mirror cases.
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return normalizeIdentifier(last) === normalizeIdentifier(receiver);
}

function normalizeIdentifier(value: string): string {
  // Strip known source extensions before character normalization so
  // `.d.ts` and the dotted compound extensions still flatten cleanly.
  const stripped = stripSourceExtension(value);
  let out = "";
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) out += stripped[i];
    else if (isUpper) out += String.fromCharCode(code + 32);
  }
  return out;
}

function stripSourceExtension(value: string): string {
  // Recognised TS / JS source suffixes. `.d.ts` is checked before the
  // single-extension variants so the longer suffix wins.
  const lowered = value.toLowerCase();
  if (lowered.endsWith(".d.ts")) return value.slice(0, -5);
  if (lowered.endsWith(".tsx") || lowered.endsWith(".jsx") || lowered.endsWith(".mjs") || lowered.endsWith(".cjs")) {
    return value.slice(0, -4);
  }
  if (lowered.endsWith(".ts") || lowered.endsWith(".js")) return value.slice(0, -3);
  return value;
}
