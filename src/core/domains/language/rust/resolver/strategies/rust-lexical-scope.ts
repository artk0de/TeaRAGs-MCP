import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type ImportRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { rustVisibleReceiverBinding } from "../visible-receiver-binding.js";
import {
  lookupRustSymbolsByShortName,
  rustCalleeShortNameCandidates,
  rustCallIsMacroInvocation,
  rustImportBindings,
  rustImportCandidatePaths,
  type ResolverConfig,
} from "./shared.js";

/** A source line span, 1-based and inclusive; `null` bounds the whole file. */
type RustLineSpan = { readonly startLine: number; readonly endLine: number } | null;

/**
 * One lexical scope enclosing a bare call, innermost first. `block` is a fn
 * body (its nested `fn` items are visible below it), `module` an inline
 * `mod x { .. }` or the file module (`path` empty), `type` an impl / trait
 * scope — it declares no item a bare path can name.
 */
interface RustLexicalScope {
  readonly kind: "block" | "module" | "type";
  readonly path: readonly string[];
  readonly span: RustLineSpan;
}

const MAX_GLOB_HOPS = 4;
const RUST_SUPER_GLOB = /^\s*super\s*::\s*\*\s*;?\s*$/;

/**
 * Lexical scope of a Rust BARE call (`foo(..)`, no receiver), read from the
 * caller file's own declarations: the nested `fn` items of each enclosing fn
 * body, innermost first, then the free fns of the enclosing module (the file
 * module or the inline `mod x { .. }` around the call). An impl member never
 * counts — a bare path cannot name `Self::helper` — and a module boundary is
 * never crossed except through that module's `use super::*`, which reaches the
 * parent module's own items. A name an explicit `use` of the scope binds
 * (including a `use a::foo as bar` rename, placed here by the import's own
 * candidate paths) is the import pass's; any other glob, a local value binding
 * of the name, or a scope the declarations cannot classify CONTINUES — the
 * chain then answers as it did before this pass.
 *
 * Two same-scope candidates (cfg-gated twins) DROP: the name is bound in this
 * scope, so nothing outside it is the target, and which twin is undecidable. A
 * module that neither declares, imports, nor glob-imports the name CONTINUES
 * even when the file declares it in a scope the call cannot see: the walker's
 * scopes are only as good as the parse, and a tree-sitter recovery that closes
 * a `mod` early (tikv `sys/thread.rs` `mod imp`, cut at its `extern "C"` block)
 * moves the module's own fns to the file root, where they look invisible.
 *
 * Chain position — after the receiver-keyed passes (a bare call passes through
 * them untouched) and BEFORE `importMatch`, `bareSelfMethod` and
 * `globalShortName`: an item of the enclosing scopes shadows every glob import
 * and cannot coexist with an explicit `use` of the same name in that scope, so
 * deciding it first only ever narrows. `importMatch` still answers every
 * explicit binding because this pass CONTINUES on one; `bareSelfMethod` resolved
 * a bare `helper()` inside `impl S` to `S#helper`, which Rust never does when the
 * module declares `fn helper`; `globalShortName` lost every same-file free fn
 * that had a workspace namesake anywhere — even a method.
 */
export class RustLexicalScopeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "lexicalScope";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null || rustCallIsMacroInvocation(call) || ctx.callerSymbolId === undefined) return CONTINUE;
    // A local value binding (`f: F`, `let f = ..`) shadows every item of the name.
    if (rustVisibleReceiverBinding(call.member, call.startLine, ctx, call.startColumn) !== undefined) return CONTINUE;
    const scopes = rustLexicalScopes(ctx.callerSymbolId, ctx, call.startLine);
    if (scopes === null) return CONTINUE;
    const sameFileCandidates = rustCalleeShortNameCandidates(ctx, call.member).filter(
      (def) => def.relPath === ctx.callerFile && def.symbolKind === "function",
    );
    const sameFileDefinitions = lookupRustSymbolsByShortName(ctx, call.member).filter(
      (def) => def.relPath === ctx.callerFile,
    );
    let inner: RustLineSpan = null;
    for (const [index, scope] of scopes.entries()) {
      if (scope.kind === "type") continue;
      const own = this.scopeItem(scope, sameFileCandidates, sameFileDefinitions);
      if (own !== undefined) return own;
      const imports = importsOf(scope.span, inner, ctx.imports);
      const bound = this.boundByImport(call.member, imports, ctx);
      if (bound !== undefined) return bound;
      if (scope.kind === "module") {
        return this.moduleGlobs(
          call.member,
          scopes.slice(index),
          imports,
          sameFileCandidates,
          sameFileDefinitions,
          ctx,
        );
      }
      if (imports.some(isGlobImport)) return CONTINUE;
      inner = scope.span;
    }
    return CONTINUE;
  }

  /** The decision the scope's own items make, or `undefined` when it declares none of the name. */
  private scopeItem(
    scope: RustLexicalScope,
    sameFileCandidates: SymbolDefinition[],
    sameFileDefinitions: SymbolDefinition[],
  ): SymbolResolutionOutcome | undefined {
    const items = sameFileCandidates.filter((def) => samePath(def.scope, scope.path));
    if (items.length > 0) {
      const target = pickSingleCandidate(items, this.cfg.mode);
      return target ? resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId }) : DROP;
    }
    // A tuple struct, constant or static of the name owns it in this scope —
    // which one the call reaches is not this pass's to decide.
    const valueItem = sameFileDefinitions.some((def) => def.symbolKind !== "method" && samePath(def.scope, scope.path));
    return valueItem ? CONTINUE : undefined;
  }

  /**
   * An explicit `use` of the scope binding the name: a rename is placed by the
   * import's own candidate paths under its SOURCE name, everything else is the
   * import pass's (CONTINUE). `undefined` when no explicit binding names it.
   */
  private boundByImport(member: string, imports: ImportRef[], ctx: CallContext): SymbolResolutionOutcome | undefined {
    for (const imp of imports) {
      const binding = rustImportBindings(imp.importText)?.find(
        (entry) => !entry.globImport && entry.localName === member,
      );
      if (!binding) continue;
      const sourceName = binding.sourceName ?? binding.moduleSegments.at(-1);
      if (sourceName === undefined || sourceName === member) return CONTINUE;
      const paths = rustImportCandidatePaths(imp.importText, member, ctx.callerFile, ctx);
      if (paths === null) return CONTINUE;
      const candidates = rustCalleeShortNameCandidates(ctx, sourceName).filter((def) => paths.includes(def.relPath));
      const target = pickSingleCandidate(candidates, this.cfg.mode);
      return target ? resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId }) : CONTINUE;
    }
    return undefined;
  }

  /**
   * The module declares and explicitly imports nothing of the name: only a glob
   * can bring it. `use super::*` of an inline module reaches the parent module's
   * own items (and, transitively, its own `use super::*`). Any other glob in the
   * module leaves the call undecidable here, even when the parent declares the
   * name. By Rust's rules the parent item would still win (a second glob
   * bringing a different item makes the use ambiguous), but the walker records
   * no untyped local `let`, and on tikv such multi-glob test modules shadow the
   * fn with one: `let prewrite = &must_pessimistic_prewrite_put_..;` in
   * `txn/actions/prewrite.rs`. Each of those landed on the parent's
   * `fn prewrite`.
   */
  private moduleGlobs(
    member: string,
    scopes: RustLexicalScope[],
    imports: ImportRef[],
    sameFileCandidates: SymbolDefinition[],
    sameFileDefinitions: SymbolDefinition[],
    ctx: CallContext,
  ): SymbolResolutionOutcome {
    let moduleScopes = scopes.filter((scope) => scope.kind === "module");
    let moduleImports = imports;
    for (let hop = 0; hop <= MAX_GLOB_HOPS; hop++) {
      const globs = moduleImports.filter(isGlobImport);
      if (globs.length === 0 || !globs.every(isSuperGlob) || moduleScopes.length < 2) return CONTINUE;
      const [child, parent] = moduleScopes;
      const own = this.scopeItem(parent, sameFileCandidates, sameFileDefinitions);
      if (own !== undefined) return own;
      moduleImports = importsOf(parent.span, child.span, ctx.imports);
      const bound = this.boundByImport(member, moduleImports, ctx);
      if (bound !== undefined) return bound;
      moduleScopes = moduleScopes.slice(1);
    }
    return CONTINUE;
  }
}

/**
 * The scopes around the caller chunk, innermost first, ending with the file
 * module — or `null` when a module or fn on the path has no declaration of
 * this file spanning the call (nothing then bounds the walk).
 */
function rustLexicalScopes(callerSymbolId: string, ctx: CallContext, line: number): RustLexicalScope[] | null {
  const ownName = callerSymbolId.split(/#|\.|::/).at(-1);
  if (ownName === undefined) return null;
  const path = [...ctx.callerScope, ownName];
  const scopes: RustLexicalScope[] = [];
  for (let depth = path.length; depth > 0; depth--) {
    const scopePath = path.slice(0, depth);
    const scope = classifyScope(scopePath, ctx, line);
    if (scope === null) return null;
    scopes.push(scope);
  }
  scopes.push({ kind: "module", path: [], span: null });
  return scopes;
}

function classifyScope(path: string[], ctx: CallContext, line: number): RustLexicalScope | null {
  const name = path[path.length - 1];
  const parent = path.slice(0, -1);
  const declarations = lookupRustSymbolsByShortName(ctx, name).filter(
    (def) => def.relPath === ctx.callerFile && samePath(def.scope, parent),
  );
  const spanning = (kinds: readonly string[]): RustLineSpan | undefined => {
    for (const { symbolKind, startLine, endLine } of declarations) {
      if (startLine === undefined || endLine === undefined || !kinds.includes(symbolKind ?? "")) continue;
      if (startLine <= line && line <= endLine) return { startLine, endLine };
    }
    return undefined;
  };
  const moduleSpan = spanning(["module"]);
  if (moduleSpan) return { kind: "module", path, span: moduleSpan };
  const blockSpan = spanning(["function", "method"]);
  if (blockSpan) return { kind: "block", path, span: blockSpan };
  if (declarations.some((def) => def.symbolKind === "module" || def.symbolKind === "function")) return null;
  // An impl / trait scope — of a type this file declares or one it only implements.
  return { kind: "type", path, span: null };
}

/** Imports written inside `span` but outside the deeper scope `inner` already read. */
function importsOf(span: RustLineSpan, inner: RustLineSpan, imports: ImportRef[]): ImportRef[] {
  return imports.filter((imp) => within(imp.startLine, span) && (inner === null || !within(imp.startLine, inner)));
}

function within(line: number, span: RustLineSpan): boolean {
  return span === null || (span.startLine <= line && line <= span.endLine);
}

function isGlobImport(imp: ImportRef): boolean {
  const bindings = rustImportBindings(imp.importText);
  return bindings === null || bindings.some((binding) => binding.globImport);
}

/** `use super::*;` — the binding parser declines a glob with no module segment, so the text decides. */
function isSuperGlob(imp: ImportRef): boolean {
  return RUST_SUPER_GLOB.test(imp.importText);
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}
