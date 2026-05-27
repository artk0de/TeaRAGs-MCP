/**
 * Go implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/go/go-resolver.ts` into the
 * native Go language provider per the `domains/language` consolidation (spec
 * §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Resolution strategy (mirrors PythonCallResolver step 0):
 *
 *   0. Local binding (bd tea-rags-mcp-e6xx): when
 *      `ctx.localBindings[receiver]` carries a known Go type name,
 *      resolve `<Type>#<member>` (instance form) against the symbol
 *      table; fall back to `<Type>.<member>` (static form) when the
 *      instance form is absent. If the type is known but the method is
 *      not defined under it, DROP the edge — never fall through to
 *      global short-name, which fabricates false positives.
 *   1. Receiver matches an import path's last segment: look up by short
 *      name and restrict to files whose path includes the import
 *      suffix.
 *   2. Receiver matches NEITHER a localBinding NOR an import: drop. Go
 *      method dispatch on chained receivers (`c.Request.URL.Query()`)
 *      is intentionally out of scope — guessing fabricates cycles.
 *   3. No receiver: global short-name fallback (top-level helpers).
 *
 * Go imports are package paths ("foo/bar"). Without GOPATH / module
 * config we can only resolve project-local packages via basename
 * heuristic — an import "foo/bar" hints that calls of `bar.Func` should
 * resolve to any file whose directory ends in `foo/bar`. Cross-module
 * imports (third-party) are out of scope; codegraph excludes `vendor/`
 * and the dependency directories the walker doesn't see.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type ResolvedTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../contracts/types/language.js";

export class GoCallResolver implements CallResolver {
  readonly language = "go";

  /**
   * `composer` builds the `Type#member` / `Type.member` candidate ids per the
   * project-wide symbolId convention (`.claude/rules/symbolid-convention.md`).
   * Injected as the contracts `SymbolIdComposer` interface. `GoLanguage`
   * self-constructs the concrete `DefaultSymbolIdComposer` (a stateless pure
   * mapper in the same `domains/language` domain) and passes it here.
   */
  constructor(
    private readonly composer: SymbolIdComposer,
    private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  ) {}

  resolve(call: CallRef, ctx: CallContext): ResolvedTarget | null {
    if (call.receiver) {
      // Step 0 — walker-inferred local type wins over heuristic
      // resolution. When the receiver maps to a known type via
      // `(r *Type)` receiver, `(p Type)` value param, or `func f(p
      // *Type)` parameter, resolution is constrained to that type;
      // edges to unrelated symbols with the same short-name are never
      // fabricated. bd tea-rags-mcp-e6xx.
      const localType = ctx.localBindings?.[call.receiver];
      if (localType) {
        return this.resolveByLocalType(localType, call.member, ctx);
      }
      // Step 0b — function-return-type binding (bd tea-rags-mcp-6g9c). When
      // the receiver was assigned from a function call (`engine := New()`),
      // `localCallBindings[receiver]` carries the called func short name and
      // `functionReturnTypes` carries that func's DECLARED return type. Bind
      // the receiver to that type ONLY when the return type is a single
      // concrete struct/type symbol that EXISTS in the table — interfaces,
      // builtins (`string`, `error`), and external `pkg.Type`s have no type
      // symbol and SKIP, falling through to the import / drop path. This is
      // SAFE: declared return types are static, not guesses. `localBindings`
      // (direct type) is checked first so it always wins.
      const calledFunc = ctx.localCallBindings?.[call.receiver];
      if (calledFunc) {
        const returnType = ctx.functionReturnTypes?.[calledFunc];
        if (returnType && this.isKnownTypeSymbol(returnType, ctx)) {
          return this.resolveByLocalType(returnType, call.member, ctx);
        }
        // Return type unknown / not a concrete type symbol — never guess.
        // Fall through to the import path below (and ultimately the drop).
      }
      const match = ctx.imports.find((imp) => importMatchesReceiver(imp.importText, call.receiver as string));
      if (match) {
        // Look up by short name globally first; restrict to a
        // candidate file whose path contains the import suffix.
        const suffix = match.importText.replace(/^\.\//, "");
        const candidates = ctx.symbolTable.lookupByShortName(call.member).filter((def) => def.relPath.includes(suffix));
        const target = pickSingleCandidate(candidates, this.mode);
        if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
      }
      // Chained / method receivers (e.g. `c.Request.URL.Query()`) and
      // bare receivers that don't match any import — we don't know the
      // dynamic type. Dropping the edge is safer than a global
      // short-name fallback, which fabricates false-positive cycles
      // (e.g. matching `c.Request.URL.Query()` against the unique
      // `Context#Query` symbol just because "Query" is unique).
      return null;
    }
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.mode);
    if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
    return null;
  }

  /**
   * Resolve a typed-receiver call: try `Type#member` (instance form)
   * first, then `Type.member` (static form). DROP — never fall through
   * to global short-name — when neither form exists. Mirrors the
   * python-resolver step 0 contract.
   */
  private resolveByLocalType(typeName: string, member: string, ctx: CallContext): ResolvedTarget | null {
    const instanceForm = this.composer.compose(typeName, member, { methodKind: "instance" });
    const staticForm = this.composer.compose(typeName, member, { methodKind: "static" });
    const instanceHits = ctx.symbolTable.lookup(instanceForm);
    const instance = pickSingleCandidate(instanceHits, this.mode);
    if (instance) return { targetRelPath: instance.relPath, targetSymbolId: instance.symbolId };
    const staticHits = ctx.symbolTable.lookup(staticForm);
    const staticHit = pickSingleCandidate(staticHits, this.mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    return null;
  }

  /**
   * Safety gate for function-return-type binding: a declared return type only
   * binds when it names a concrete type that EXISTS as a symbol in the table
   * (`type Engine struct {...}` → symbol `Engine`). Interfaces, builtins
   * (`string`, `error`), and external `pkg.Type`s have no project-local type
   * symbol, so they SKIP rather than fabricate an edge. Matched by exact fqName
   * first (top-level type, `Engine`), then by short name (nested / scoped type
   * declarations) — either match means a real type symbol was extracted.
   */
  private isKnownTypeSymbol(typeName: string, ctx: CallContext): boolean {
    if (ctx.symbolTable.lookup(typeName).length > 0) return true;
    return ctx.symbolTable.lookupByShortName(typeName).length > 0;
  }
}

function importMatchesReceiver(importText: string, receiver: string): boolean {
  const segments = importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
