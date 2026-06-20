/**
 * JavaScript implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/javascript/javascript-resolver.ts`
 * into the native JavaScript language provider per the `domains/language`
 * consolidation (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Plain JS (no tsconfig paths, no .ts extension games). Imports are
 * either:
 *   - relative paths: `./foo`, `../foo/bar` — resolved against the
 *     caller's directory, with `.js`/`.jsx`/`.mjs`/`.cjs` extension
 *     guessing.
 *   - bare specifiers (`react`, `lodash`) — out of scope; only matter
 *     for node_modules which codegraph excludes.
 *
 * Receiver matching: same heuristic as TS — the import's last path
 * segment must match the receiver case-insensitively. The walker
 * already filters require/import from the calls collection so the
 * receiver list here only contains real method calls.
 */

import { posix } from "node:path";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import { ECMASCRIPT_GLOBALS } from "../../kernel/ecmascript-globals.js";

const JS_EXTS = [".js", ".jsx", ".mjs", ".cjs"];

export class JavascriptCallResolver implements CallResolver {
  readonly language = "javascript";

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {}

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    // `super(...)` / `super.X()` — walk to the PARENT class via
    // `classExtends`, then resolve `<Parent>#<member>`. Without
    // classExtends data we cannot know the parent and MUST return
    // null rather than fall through to same-file lookup — that path
    // would route back to the enclosing class's own method and emit
    // a self-loop edge (bd `tea-rags-mcp-4rgg`). Mirrors the TS
    // resolver's `resolveSuper` walk pattern.
    if (call.receiver === "super") {
      return this.resolveSuper(call.member, ctx);
    }
    // Intra-class `this.X()` — same-file lookup of `<EnclosingClass>#X`.
    // Target symbolId composes as `<EnclosingClass>#<member>` per the
    // project convention (`.claude/rules/symbolid-convention.md`).
    // Falls back to `.` (static) and same-file short-name only when
    // the instance lookup misses.
    if (call.receiver === "this") {
      if (ctx.callerScope.length > 0) {
        const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
        const fqName = `${enclosing}#${call.member}`;
        const direct = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
        if (direct) return { targetRelPath: direct.relPath, targetSymbolId: direct.symbolId };
        const staticFqName = `${enclosing}.${call.member}`;
        const staticHit = ctx.symbolTable.lookup(staticFqName).find((def) => def.relPath === ctx.callerFile);
        if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
        const sameFile = ctx.symbolTable.lookupByShortName(call.member).find((def) => def.relPath === ctx.callerFile);
        if (sameFile) return { targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId };
      }
    }
    if (call.receiver) {
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        const targetFile = mapJavascriptImportToFile(match.importText, ctx.callerFile);
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
   * Resolve `super(...)` / `super.foo()` by walking `ctx.classExtends`
   * from the enclosing class to find the parent, then looking up
   * `<Parent>#<member>` in the symbol table. Walks transitively up the
   * chain when the direct parent lacks the method (B extends A extends
   * C, C owns the method).
   *
   * Returns null when:
   *   - callerScope is empty (no enclosing class).
   *   - classExtends is undefined or has no entry for the enclosing class.
   *   - the walk exhausts without finding the method AND no file-only
   *     fallback could be derived.
   *
   * The null return is intentional — without parent info, falling back
   * to same-file lookup would route to the enclosing class's own method
   * and emit a self-loop edge (bd `tea-rags-mcp-4rgg`). Returning null
   * means "no edge" rather than "wrong edge". Mirrors the TS resolver's
   * `resolveSuper` (bd tea-rags-mcp-4rgg).
   *
   * `visited` defends against accidental cycles in `classExtends` data.
   */
  private resolveSuper(member: string, ctx: CallContext): SymbolResolutionTarget | null {
    if (ctx.callerScope.length === 0) return null;
    if (!ctx.classExtends) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    const visited = new Set<string>([enclosing]);
    let fileOnlyFallback: SymbolResolutionTarget | null = null;
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
      // the TS resolver's file-only fallback for out-of-project parents
      // (e.g. `extends EventEmitter` where the method lives in
      // node_modules outside the index).
      if (fileOnlyFallback === null) {
        const ancestorShort = lastSegment(current);
        const ancestorDef = ctx.symbolTable
          .lookupByShortName(ancestorShort)
          .find((def) => def.scope.length === 0 && def.shortName === ancestorShort);
        if (ancestorDef) {
          fileOnlyFallback = { targetRelPath: ancestorDef.relPath, targetSymbolId: null };
        } else {
          for (const def of ctx.symbolTable.lookupByShortName(member)) {
            if (def.scope[def.scope.length - 1] === current) {
              fileOnlyFallback = { targetRelPath: def.relPath, targetSymbolId: null };
              break;
            }
          }
          if (fileOnlyFallback === null) {
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

  /**
   * tea-rags-mcp-ykj7 — external-import classifier for an UNRESOLVED call.
   * `true` when the receiver is an ECMAScript ambient global (`console.log`,
   * `Math.max` — no import), or matches an import whose specifier is BARE
   * (npm package: `mapJavascriptImportToFile` returns `null` for everything
   * that isn't a relative project path). The JS walker does not populate
   * `importedNames`, so receiver↔import matching reuses the resolver's existing
   * last-path-segment heuristic (`importMatchesReceiver`).
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
    const boundName = receiver ?? call.member;
    if (boundName.length === 0) return false;
    for (const imp of ctx.imports) {
      if (
        importMatchesReceiver(imp.importText, boundName) &&
        mapJavascriptImportToFile(imp.importText, ctx.callerFile) === null
      ) {
        return true;
      }
    }
    return false;
  }
}

function lastSegment(qualified: string): string {
  // `A.B.C` → `C`. Used to look up the short-name of a qualified
  // parent class for the file-only fallback in `resolveSuper`.
  const dot = qualified.lastIndexOf(".");
  return dot >= 0 ? qualified.slice(dot + 1) : qualified;
}

export function mapJavascriptImportToFile(importText: string, callerFile: string): string | null {
  // Only relative imports resolve to project-local files. Bare
  // specifiers (npm packages) are out of scope — codegraph excludes
  // node_modules from the walk.
  if (!importText.startsWith(".")) return null;
  const callerDir = posix.dirname(callerFile);
  const joined = posix.normalize(posix.join(callerDir, importText));
  // If the import already carries an extension, keep it (Node modern
  // ESM requires explicit extensions). Otherwise default to `.js`.
  for (const ext of JS_EXTS) {
    if (joined.endsWith(ext)) return joined;
  }
  return `${joined}.js`;
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  // Strip extension if any so `./foo.js` matches receiver `foo`.
  const cleaned = last.replace(/\.(js|jsx|mjs|cjs)$/, "");
  return cleaned.toLowerCase() === receiver.toLowerCase();
}
