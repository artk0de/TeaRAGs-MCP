import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * `super(...)` / `super.X()` — walk to the PARENT class via `classExtends`,
 * then resolve `<Parent>#<member>`. This is the one **guard** strategy: when
 * the receiver is `super` it is always terminal — it either resolves or
 * **drops**, never continues. Without `classExtends` data we cannot know the
 * parent and MUST drop rather than fall through to a later same-file lookup —
 * that path would route back to the enclosing class's own method and emit a
 * self-loop edge (bd `tea-rags-mcp-4rgg`). Mirrors Ruby's `resolveSuper` walk
 * pattern with single inheritance.
 */
export class TSSuperSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "super";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "super") return CONTINUE;
    const target = this.resolveSuper(call.member, ctx);
    // `super` is terminal: a miss is a DROP, not a fall-through (bd 4rgg).
    return target ? resolved(target) : DROP;
  }

  /**
   * Resolve a `super(...)` / `super.X()` call against the PARENT class
   * determined by `ctx.classExtends`. Walks the single-inheritance chain
   * (B extends A, A extends C, ...) until an ancestor's file owns a symbol
   * matching `member`. Returns:
   *
   *   - `{ relPath, symbolId }` when an ancestor in the chain has the method
   *     (instance form preferred; static fallback) — the winning edge.
   *   - `{ relPath, targetSymbolId: null }` when an ancestor's file is known
   *     but no symbol matches (method comes from a deeper out-of-project class
   *     — file-level fan stays accurate).
   *   - `null` when the enclosing class is unknown to `classExtends`, when the
   *     parent chain leads only to external classes (not in the symbol table),
   *     or when `callerScope` is empty.
   *
   * `visited` defends against accidental cycles in `classExtends` data
   * (well-formed TS rejects circular extends, but the walker may emit a cycle
   * if the input is malformed — defensive guard).
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
      // Prefer the instance form (`#`) — `super(arg)` / `super.foo()` are
      // instance-method dispatches by definition. Static fallback covers the
      // unusual `super.staticHelper()` shape.
      const instanceFq = `${current}#${member}`;
      const instanceHit = ctx.symbolTable.lookup(instanceFq);
      const instanceTarget = pickSingleCandidate(instanceHit, this.cfg.mode);
      if (instanceTarget) {
        return { targetRelPath: instanceTarget.relPath, targetSymbolId: instanceTarget.symbolId };
      }
      const staticFq = `${current}.${member}`;
      const staticHit = ctx.symbolTable.lookup(staticFq);
      const staticTarget = pickSingleCandidate(staticHit, this.cfg.mode);
      if (staticTarget) {
        return { targetRelPath: staticTarget.relPath, targetSymbolId: staticTarget.symbolId };
      }
      // Method not found on `current` itself — remember the first ancestor
      // whose file IS known so we can emit a file-only edge when the chain
      // exhausts without a method-level hit. Mirrors Ruby `resolveSuper`'s
      // file-only fallback for out-of-project parents (e.g. `extends
      // EventEmitter` where the method lives in node_modules outside the index).
      //
      // To find the ancestor's file, look for ANY symbol whose scope ends with
      // the ancestor's name (covers `Base`, `Base#foo`, `Base.bar` — all carry
      // `scope[-1] === "Base"`). The class declaration itself also creates a
      // top-level symbol whose `shortName === current` (e.g. fqName `Base`).
      if (fileOnlyFallback === null) {
        const ancestorShort = lastSegment(current);
        const ancestorDef = ctx.symbolTable
          .lookupByShortName(ancestorShort)
          .find((def) => def.scope.length === 0 && def.shortName === ancestorShort);
        if (ancestorDef) {
          fileOnlyFallback = { targetRelPath: ancestorDef.relPath, targetSymbolId: null };
        } else {
          // Fall back to the file of any method whose scope is the ancestor —
          // covers files that only have method symbols (the class declaration
          // itself wasn't indexed as a top-level symbol, only its methods).
          for (const def of ctx.symbolTable.lookupByShortName(member)) {
            if (def.scope[def.scope.length - 1] === current) {
              fileOnlyFallback = { targetRelPath: def.relPath, targetSymbolId: null };
              break;
            }
          }
          if (fileOnlyFallback === null) {
            // Last resort — scan for ANY symbol whose innermost scope is
            // `current`. Captures the case where the parent class has arbitrary
            // indexed members (constructor, fields, etc.) but no match for
            // `member` and no top-level Base symbol.
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
      // Walk one step deeper. `classExtends` carries one parent per class —
      // single inheritance, no mixin chain to consider.
      current = ctx.classExtends[current];
    }
    return fileOnlyFallback;
  }
}

function lastSegment(qualified: string): string {
  // `A.B.C` → `C`. Used to look up the short-name of a qualified parent class
  // for the file-only fallback in `resolveSuper`.
  const dot = qualified.lastIndexOf(".");
  return dot === -1 ? qualified : qualified.slice(dot + 1);
}
