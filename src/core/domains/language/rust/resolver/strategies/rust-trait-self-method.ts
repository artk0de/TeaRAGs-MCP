import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef, SymbolDefinition } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { RunScopedMemo } from "../../../kernel/index.js";
import { rustTextIsStdMethodName } from "../../vocabulary/std-method-names.js";
import { rustLexicalSelfType } from "../declared-field-type.js";
import { resolveRustMemberWithDeref } from "../rust-type-member-lookup.js";
import { lookupRustSymbolsByShortName, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-s3i8m Task 2 rule 5 — a `self.m()` whose body is a TRAIT's
 * method: a default method the impl does not override, or one handed to `Self`
 * by an impl the source does not show (codegen, derive, a blanket
 * `impl<T: B> Tr for T`). The last pass of the chain, so it answers only where
 * every other pass stayed silent; reading order mirrors Rust's own probe:
 *
 *   1. the enclosing type's `Deref` walk — a target's member beats any trait
 *      read; a type that defines the member ITSELF anywhere (inherent, or an
 *      impl overriding the default) is the earlier passes' to answer, and
 *      their silence there is an ambiguity, never a trait default;
 *   2. PROOF — the traits the caller's `Self` provably has: a trait body's own
 *      trait plus supertraits, or the enclosing type's `implements` edges plus
 *      their supertraits. Exactly one declarer resolves, several continue;
 *   3. GUESS — no proof names a declarer, `Self` is a trait body or a project
 *      struct / enum with no `Deref` of its own (an impl on a foreign type,
 *      `impl R for mpsc::SyncSender<_>`, hands `self` that type's unseen
 *      inherent methods), and std answers no method of that name
 *      (`rustTextIsStdMethodName`): exactly one project trait declaring the
 *      member resolves.
 *
 * A trait's bodiless signature is in the table as `Tr::m`, a default method as
 * `Tr#m`; both are the trait's declaration of `m`.
 */
export class RustTraitSelfMethodSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "traitSelfMethod";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    const declarers = rustTraitDeclarersOf(call.member, ctx);
    if (declarers.length === 0) return CONTINUE;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    const enclosingIsTrait = rustCallerDeclaresTrait(ctx);
    if (!enclosingIsTrait) {
      const selfType = rustLexicalSelfType(ctx);
      if (selfType?.form === "instance" || selfType?.form === "class") {
        const viaDeref = resolveRustMemberWithDeref(selfType, call.member, ctx, this.cfg.mode);
        if (viaDeref !== null) return resolved(viaDeref);
      }
      if (rustTypeOwnsMember(enclosing, call.member, ctx)) return CONTINUE;
    }
    const provenTraits = enclosingIsTrait
      ? rustWithSupertraits([enclosing], ctx)
      : rustWithSupertraits(rustImplementedTraits(enclosing, ctx), ctx);
    const proven = declarers.filter((declarer) => provenTraits.has(declarer.trait));
    if (proven.length > 0) return proven.length === 1 ? resolvedTo(proven[0].def) : CONTINUE;
    if (rustTextIsStdMethodName(call.member)) return CONTINUE;
    if (!enclosingIsTrait && !rustSelfIsProjectTypeWithoutDeref(enclosing, ctx)) return CONTINUE;
    return declarers.length === 1 ? resolvedTo(declarers[0].def) : CONTINUE;
  }
}

function resolvedTo(def: SymbolDefinition): SymbolResolutionOutcome {
  return resolved({ targetRelPath: def.relPath, targetSymbolId: def.symbolId });
}

interface RustTraitDeclarer {
  /** The declaring trait's short name. */
  readonly trait: string;
  readonly def: SymbolDefinition;
}

/** Every project trait's declaration of `member` — a default `Tr#m` or a signature `Tr::m`. */
function rustTraitDeclarersOf(member: string, ctx: CallContext): RustTraitDeclarer[] {
  const traitDeclarers: RustTraitDeclarer[] = [];
  for (const def of lookupRustSymbolsByShortName(ctx, member)) {
    if (def.symbolKind !== "method") continue;
    const ownerId = rustTraitMemberOwnerId(def.symbolId, member);
    if (ownerId === undefined) continue;
    const isTrait = ctx.symbolTable
      .lookup(ownerId)
      .some((owner) => owner.relPath === def.relPath && owner.symbolKind === "interface");
    if (isTrait) traitDeclarers.push({ trait: ownerId.split("::").at(-1) ?? ownerId, def });
  }
  return traitDeclarers;
}

function rustTraitMemberOwnerId(symbolId: string, member: string): string | undefined {
  for (const separator of ["#", "::"]) {
    const suffix = `${separator}${member}`;
    if (symbolId.endsWith(suffix) && symbolId.length > suffix.length) return symbolId.slice(0, -suffix.length);
  }
  return undefined;
}

/** The caller is a method of a trait body declared in its own file — `Self` is that trait's implementor. */
function rustCallerDeclaresTrait(ctx: CallContext): boolean {
  const traitId = ctx.callerScope.join("::");
  return (ctx.typeDeclarations?.[ctx.callerFile] ?? []).some(
    (fact) => fact.typeId === traitId && fact.symbolKind === "interface" && !fact.reopens,
  );
}

/** The traits `impl Tr for <typeName>` blocks name, by short name. */
function rustImplementedTraits(typeName: string, ctx: CallContext): string[] {
  return (ctx.hierarchy?.getAncestors(typeName, { kinds: ["implements"] }) ?? []).map(
    (edge) => edge.ancestorFqName.split("::").at(-1) ?? edge.ancestorFqName,
  );
}

/** `traits` closed over their supertraits, read from the run's trait declaration facts. */
function rustWithSupertraits(traits: readonly string[], ctx: CallContext): ReadonlySet<string> {
  const closed = new Set<string>();
  const pending = [...traits];
  const supertraits = rustSupertraitsByName(ctx);
  for (let trait = pending.pop(); trait !== undefined; trait = pending.pop()) {
    if (closed.has(trait)) continue;
    closed.add(trait);
    pending.push(...(supertraits.get(trait) ?? []));
  }
  return closed;
}

const SUPERTRAITS_BY_NAME = new RunScopedMemo<
  object,
  { files: number; byName: ReadonlyMap<string, readonly string[]> }
>();

/**
 * Trait short name → its supertraits' short names, every declaring file merged.
 * Memoised per resolve run and rebuilt when the facts map's file count moves:
 * the run state fills that map in place while it absorbs files.
 */
function rustSupertraitsByName(ctx: CallContext): ReadonlyMap<string, readonly string[]> {
  const declarations = ctx.typeDeclarations;
  if (declarations === undefined) return new Map();
  const files = Object.keys(declarations).length;
  const cached = SUPERTRAITS_BY_NAME.get(ctx.runScope, declarations);
  if (cached?.files === files) return cached.byName;
  const byName = new Map<string, string[]>();
  for (const facts of Object.values(declarations)) {
    for (const fact of facts) {
      if (fact.symbolKind !== "interface" || fact.conforms === undefined) continue;
      const name = fact.typeId.split("::").at(-1) ?? fact.typeId;
      const list = byName.get(name) ?? [];
      list.push(...fact.conforms.map((bound) => bound.split("::").at(-1) ?? bound));
      byName.set(name, list);
    }
  }
  SUPERTRAITS_BY_NAME.set(ctx.runScope, declarations, { files, byName });
  return byName;
}

const RUST_NOMINAL_KINDS: ReadonlySet<string> = new Set(["class", "enum"]);

/** `Self` names a project struct / enum, and no type of that name defines `deref`. */
function rustSelfIsProjectTypeWithoutDeref(typeName: string, ctx: CallContext): boolean {
  const declared = lookupRustSymbolsByShortName(ctx, typeName).some(
    (def) =>
      def.symbolKind !== undefined &&
      RUST_NOMINAL_KINDS.has(def.symbolKind) &&
      (def.symbolId === typeName || def.symbolId.endsWith(`::${typeName}`)),
  );
  return declared && !rustTypeOwnsMember(typeName, "deref", ctx);
}

/** Some project type of this short name defines `member` in an impl block — by name, so any crate's namesake counts. */
function rustTypeOwnsMember(typeName: string, member: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, member).some((def) => def.scope.at(-1) === typeName);
}
