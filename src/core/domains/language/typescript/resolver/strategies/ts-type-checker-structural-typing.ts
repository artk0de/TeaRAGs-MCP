/**
 * Type-checker pass for receivers that have no NAME to look up
 * (bd tea-rags-mcp-icmnr).
 *
 * Every tree-sitter pass ahead of this one resolves by naming something: a
 * class, an interface, an import specifier, a walker-bound type. Two families
 * of call defeat that by construction.
 *
 *   - **Structural / duck typing.** `const x: { foo(): void } = …` or a
 *     parameter typed by an inline object literal. There is no nominal type
 *     anywhere, so `TSFieldTypeSymbolResolutionStrategy` and
 *     `TSConeTypeLocator` — both of which start from a type NAME and look up
 *     its declaring file — have nothing to start from. The same holds for the
 *     duck-typed namespace object (`export const handlers = { onSave() {…} }`),
 *     which is a plain object literal with real bodies hanging off it.
 *   - **Interface declaration merging.** Several `interface Foo` declarations,
 *     in different files or the same one, contribute to ONE type. A call on a
 *     `Foo`-typed receiver may land on a member declared at any merge site, so
 *     picking "the first `interface Foo`" — the only thing a name lookup can do
 *     — names the wrong file whenever the member came from a later declaration.
 *
 * Both are answered by the same two checker calls: `getTypeAtLocation` on the
 * receiver EXPRESSION (not its text), then `getProperty(member)` on the
 * resulting type. The compiler has already done the structural matching and the
 * declaration merging; `getDeclarations()` then reports every site the member
 * is declared at, which is exactly the set a name lookup cannot see.
 *
 * It sits after {@link TSTypeCheckerFallbackSymbolResolutionStrategy} and
 * shares that pass's {@link TSProgramCache} — one set of Programs per run, not
 * two — so on a file the fallback already typed this pass costs two checker
 * queries and no I/O. `CODEGRAPH_TS_TYPECHECKER=0` removes both passes.
 *
 * Precision over recall, as in the fallback: a declaration outside the project
 * yields `continue` (the external classifier buckets it), a member the checker
 * cannot find yields `continue`, and a merge whose sites the symbol table
 * cannot narrow to one file yields `continue` rather than a guess. What it will
 * emit on thin evidence is a FILE-only edge — a null `targetSymbolId` is the
 * contract's way of saying "the file is certain, the member is not", and for a
 * structurally-typed member the file is very often all that exists to know.
 */

import ts from "typescript";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type RelPath,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../../../infra/symbolid/index.js";
import { ECMASCRIPT_BUILTIN_TYPES, ECMASCRIPT_GLOBALS } from "../../../shared/ecmascript-globals.js";
import { mapImportToFile, type TsCompilerOptions } from "../ts-path-mapper.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Why a receiver is worth asking the checker about.
 *
 *   - `structural` — the walker bound NO type to the receiver. Either it is
 *     duck-typed (an object literal, an inline type literal) or its type is
 *     inferred; in both cases no earlier pass had a name to work with.
 *   - `merged` — the walker DID bind a nominal type, and every name-based pass
 *     still declined. Declaration merging is the standard reason: the member
 *     lives on a merge site the symbol table does not carry under that type's
 *     composed id.
 */
export type TSStructuralTypingCase = "structural" | "merged";

/** TypeScript joins namespaces and static members with a dot. */
const TS_SCOPE_SEPARATOR = ".";

/** `this.<field>` receivers are one level deep by convention across the TS passes. */
const THIS_PREFIX = "this.";

/**
 * Decide whether a call the earlier passes declined carries a receiver worth
 * typing. Pure and cheap — it reads the call text, the walker's binding maps
 * and the import list, never the file system.
 *
 * The three declines are all cost control, not correctness: an ambient
 * namespace (`Math.max`), a receiver bound to an import that leaves the project
 * (`axios.get`), and a receiver whose bound type is an ECMAScript builtin
 * instance (`cache.get` on a `Map`) can only ever resolve into the default lib
 * or `node_modules`, which {@link TSStructuralTypingSymbolResolutionStrategy}
 * would reject anyway — after paying for a Program.
 */
export function classifyStructuralTypingCase(
  call: CallRef,
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
): TSStructuralTypingCase | null {
  const { receiver } = call;
  if (receiver === null || receiver.length === 0) return null;
  if (ECMASCRIPT_GLOBALS.has(rootIdentifier(receiver))) return null;
  if (bindsToExternalImport(rootIdentifier(receiver), ctx, tsOptions)) return null;

  const boundType = boundReceiverType(call, ctx);
  if (boundType !== null && ECMASCRIPT_BUILTIN_TYPES.has(boundType)) return null;
  return boundType === null ? "structural" : "merged";
}

export class TSStructuralTypingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "structuralTyping";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const kind = classifyStructuralTypingCase(call, ctx, this.cfg.tsOptions);
    if (kind === null) return CONTINUE;

    const handle = this.programCache.acquire(ctx.callerFile);
    if (!handle) return CONTINUE;

    const access = findMemberAccess(handle.sourceFile, call.startLine, call.member);
    if (!access) return CONTINUE;

    // The receiver EXPRESSION, not its text: this is what lets `this.out.emit()`
    // and `handlers.onSave()` take the same path, and what makes the structural
    // match the compiler's rather than ours.
    const receiverType = handle.checker.getApparentType(handle.checker.getTypeAtLocation(access.expression));
    if (kind === "merged" && !isMergedDeclaration(receiverType)) return CONTINUE;

    const declarations = receiverType.getProperty(call.member)?.getDeclarations() ?? [];

    const sites = this.inProjectSites(declarations);
    if (sites.length === 0) return CONTINUE;
    return this.emit(sites, call.member, ctx);
  }

  /**
   * Declaration sites that live inside the indexed project, paired with their
   * `RelPath`. A member declared only in `node_modules` or the default lib
   * leaves this empty and the call falls through to the external classifier,
   * exactly as the type-checker fallback does.
   */
  private inProjectSites(declarations: readonly ts.Declaration[]): DeclarationSite[] {
    const sites: DeclarationSite[] = [];
    for (const declaration of declarations) {
      const relPath = this.programCache.toRelPath(declaration.getSourceFile().fileName);
      if (relPath !== null) sites.push({ declaration, relPath });
    }
    return sites;
  }

  /**
   * Turn the declaration sites into one edge.
   *
   * ONE file — the ordinary case, including a merge whose sites all live in the
   * same file — is certain, so the edge is emitted with whatever symbol the
   * table can pin, or file-only when it can pin nothing.
   *
   * SEVERAL files is the conflicting-merge case: two `interface Foo`
   * declarations in different files both declaring the member, which the
   * compiler merges into overloads. The checker knows the member's type, not
   * which site "the" edge belongs to, so the symbol table breaks the tie — and
   * only by an OWNER-EXACT match (`Foo#member`), never by short name. Short-name
   * narrowing is safe once the file is known but would happily confirm an
   * unrelated `send` in the other merge site's file, converting a deferral into
   * a fabricated edge. No single confirmation, or several, means defer.
   *
   * Overload SELECTION is deliberately not attempted here — picking the
   * signature that matches the arguments is `getResolvedSignature`'s job, and
   * that is the pass ahead of this one.
   */
  private emit(sites: DeclarationSite[], member: string, ctx: CallContext): SymbolResolutionOutcome {
    const files = new Set(sites.map((site) => site.relPath));
    if (files.size === 1) {
      const [targetRelPath] = [...files];
      return resolved({ targetRelPath, targetSymbolId: this.pinWithinFile(sites, member, targetRelPath, ctx) });
    }

    const confirmed = new Map<RelPath, string>();
    for (const site of sites) {
      const symbolId = ownerExactSymbolId(site, member, ctx);
      if (symbolId !== null) confirmed.set(site.relPath, symbolId);
    }
    if (confirmed.size !== 1) return CONTINUE;

    const [[targetRelPath, targetSymbolId]] = [...confirmed];
    return resolved({ targetRelPath, targetSymbolId });
  }

  /**
   * The symbolId for a member whose FILE is already certain. The declaration's
   * nominal owner (`interface Plugin` → `Plugin#teardown`) is tried first;
   * failing that — an object literal or a type literal has no owner name at all
   * — the member's short name narrowed to that one file, which is unambiguous
   * often enough to be worth trying and drops to `null` when it is not.
   */
  private pinWithinFile(
    sites: DeclarationSite[],
    member: string,
    targetRelPath: RelPath,
    ctx: CallContext,
  ): string | null {
    for (const site of sites) {
      const symbolId = ownerExactSymbolId(site, member, ctx);
      if (symbolId !== null) return symbolId;
    }
    const byShortName = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === targetRelPath);
    return pickSingleCandidate(byShortName, this.cfg.mode)?.symbolId ?? null;
  }
}

/**
 * Did the receiver's TYPE come from more than one declaration — the literal
 * definition of declaration merging?
 *
 * This is what keeps the `merged` arm from quietly changing the answer for
 * ordinary interface-typed receivers. A single-declaration `interface Store`
 * whose implementers the name passes could not narrow is not this pass's
 * problem: the CHA cone (`ConeDispatchResolver`) already fans such a call out
 * to the implementers that override the member, and emitting a declaration-site
 * edge here instead would trade that fan-out for a pointer at the interface.
 * Only when the type genuinely spans several declarations does this pass know
 * something no name lookup could.
 */
function isMergedDeclaration(type: ts.Type): boolean {
  return (type.getSymbol()?.getDeclarations()?.length ?? 0) >= 2;
}

/** One declaration of the member, with the project file it was declared in. */
interface DeclarationSite {
  declaration: ts.Declaration;
  relPath: RelPath;
}

/**
 * `Owner#member` / `Owner.member` confirmed against the symbol table AND
 * against this declaration's own file. Returns `null` when the declaration has
 * no nominal owner (an object literal, a type literal) or when the table
 * carries no such symbol in that file.
 */
function ownerExactSymbolId(site: DeclarationSite, member: string, ctx: CallContext): string | null {
  const owner = nominalOwnerName(site.declaration);
  if (owner === null) return null;
  for (const separator of [INSTANCE_METHOD_SEPARATOR, TS_SCOPE_SEPARATOR]) {
    const hits = ctx.symbolTable.lookup(`${owner}${separator}${member}`).filter((def) => def.relPath === site.relPath);
    if (hits.length > 0) return hits[0].symbolId;
  }
  return null;
}

/**
 * The name of the interface or class the declaration hangs off, or `null` for
 * the structural containers — an object literal, a type literal, a mapped type
 * — which is precisely the case that has no name to look up.
 */
function nominalOwnerName(declaration: ts.Declaration): string | null {
  const owner = declaration.parent;
  if (owner === undefined) return null;
  if (ts.isInterfaceDeclaration(owner)) return owner.name.text;
  if (ts.isClassLike(owner)) return owner.name?.text ?? null;
  return null;
}

/** `this` in `this.out`, `handlers` in `handlers.onSave` — the binding a name lookup would use. */
function rootIdentifier(receiver: string): string {
  const dot = receiver.indexOf(TS_SCOPE_SEPARATOR);
  return dot === -1 ? receiver : receiver.slice(0, dot);
}

/**
 * The type the WALKER bound to the receiver, mirroring the two maps the
 * tree-sitter passes read: `classFieldTypes` for `this.<field>`,
 * `localBindings` for a plain identifier. `null` means the walker had no type
 * for it, which is the structural signal.
 */
function boundReceiverType(call: CallRef, ctx: CallContext): string | null {
  const receiver = call.receiver ?? "";
  if (receiver.startsWith(THIS_PREFIX)) {
    const field = receiver.slice(THIS_PREFIX.length);
    if (field.includes(TS_SCOPE_SEPARATOR) || ctx.callerScope.length === 0) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    return ctx.classFieldTypes?.[enclosing]?.[field] ?? null;
  }
  return resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) ?? null;
}

/**
 * Is the receiver's binding introduced by an import that does NOT map to a
 * project file? `mapImportToFile` returns `null` for exactly those (bare npm
 * specifiers, `node:` builtins), which is the same test
 * `TSCallResolver.targetsExternalImport` uses to bucket a call as external.
 */
function bindsToExternalImport(name: string, ctx: CallContext, tsOptions: TsCompilerOptions): boolean {
  for (const imp of ctx.imports) {
    if (imp.importedNames?.includes(name) && mapImportToFile(imp.importText, ctx.callerFile, tsOptions) === null) {
      return true;
    }
  }
  return false;
}

/**
 * The property access of the first call on `startLine` (1-based, matching
 * `CallRef.startLine`) whose member name is `member`. Only property accesses
 * qualify — a bare `run()` has no receiver to type, and this pass exists for
 * receivers. Both coordinates are checked because one line routinely holds
 * several calls.
 */
function findMemberAccess(
  sourceFile: ts.SourceFile,
  startLine: number,
  member: string,
): ts.PropertyAccessExpression | null {
  let found: ts.PropertyAccessExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee.name) && callee.name.text === member) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (line === startLine) {
          found = callee;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}
