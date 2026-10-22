import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type {
  CallContext,
  CallRef,
  SymbolDefinition,
  TypeDeclarationFact,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { RunScopedMemo } from "../../../kernel/index.js";
import { rustTextIsStdMethodName } from "../../vocabulary/std-method-names.js";
import { rustLexicalSelfType } from "../declared-field-type.js";
import { rustCallerCrateUniqueType, rustCrateRootOf } from "../rust-crate-scope.js";
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
 *   2. PROOF — the traits the caller's `Self` provably has, closed over their
 *      supertraits: a trait body's own trait; the enclosing `impl Tr for X`'s
 *      own `Tr`; for a generic `Self` (`impl<T: B> Tr for T`) the bounds of
 *      `T`, inline and `where`; and for a concrete `X` whose short name is
 *      unique in the caller's crate, the traits every trait impl of `X` in
 *      that crate names (else, when the caller's file declares `X`, that
 *      file's own impls) — a namesake elsewhere lends none. Exactly one
 *      declarer resolves, several continue; a generic `Self` stops here;
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
    const traitImpl = enclosingIsTrait ? undefined : rustEnclosingTraitImpl(call, ctx);
    if (traitImpl !== undefined && rustTraitImplSelfIsGeneric(traitImpl)) {
      if (rustImplBlockOwnsMember(traitImpl, call.member, ctx)) return CONTINUE;
      const bounded = rustWithSupertraits([...rustImplHeaderTraits(traitImpl), ...rustImplSelfBounds(traitImpl)], ctx);
      const proven = declarers.filter((declarer) => bounded.has(declarer.trait));
      return proven.length === 1 ? resolvedTo(proven[0].def) : CONTINUE;
    }
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
      : rustWithSupertraits(
          [
            ...(traitImpl === undefined ? [] : rustImplHeaderTraits(traitImpl)),
            ...rustImplementedTraits(enclosing, ctx),
          ],
          ctx,
        );
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

const shortNameOf = (path: string): string => path.split("::").at(-1) ?? path;

/** The trait impl whose body holds the call — a re-opening fact of the caller's scope spanning its line. */
function rustEnclosingTraitImpl(call: CallRef, ctx: CallContext): TypeDeclarationFact | undefined {
  const selfId = ctx.callerScope.join("::");
  let innermost: TypeDeclarationFact | undefined;
  for (const fact of ctx.typeDeclarations?.[ctx.callerFile] ?? []) {
    const span = fact.selfConstraints;
    if (!fact.reopens || fact.typeId !== selfId || span === undefined) continue;
    if (call.startLine < span.startLine || call.startLine > span.endLine) continue;
    if (innermost === undefined || span.startLine > (innermost.selfConstraints?.startLine ?? 0)) innermost = fact;
  }
  return innermost;
}

/** `impl<T: B> Tr for T` — `Self` is one of the impl's own type parameters. */
function rustTraitImplSelfIsGeneric(fact: TypeDeclarationFact): boolean {
  return fact.genericParameters?.includes(fact.typeId) === true;
}

/** The trait an `impl Tr for X` header names, by short name. */
function rustImplHeaderTraits(fact: TypeDeclarationFact): string[] {
  return (fact.conforms ?? []).map(shortNameOf);
}

/** A generic `Self`'s bounds, by short name. */
function rustImplSelfBounds(fact: TypeDeclarationFact): string[] {
  return (fact.selfConstraints?.types ?? []).map(shortNameOf);
}

/** Some impl block of the caller's file on the same generic self parameter defines `member` itself. */
function rustImplBlockOwnsMember(fact: TypeDeclarationFact, member: string, ctx: CallContext): boolean {
  return lookupRustSymbolsByShortName(ctx, member).some(
    (def) => def.relPath === ctx.callerFile && def.scope.join("::") === fact.typeId,
  );
}

/**
 * The traits trait impls of `typeName` name, by short name. Impl facts are
 * keyed by short name, so only impls that provably name the caller's type
 * count: every impl in the caller's crate when the name is unique there, else
 * only the impls of the caller's own file when that file declares the type —
 * a namesake elsewhere lends none.
 */
function rustImplementedTraits(typeName: string, ctx: CallContext): string[] {
  const impls = rustTraitFactIndex(ctx).implsBySelfName.get(typeName) ?? [];
  if (rustCallerCrateUniqueType(typeName, ctx) !== undefined) {
    const root = rustCrateRootOf(ctx.callerFile, ctx);
    return impls.filter((impl) => rustCrateRootOf(impl.relPath, ctx) === root).flatMap((impl) => impl.traits);
  }
  const selfId = ctx.callerScope.join("::");
  const declaredHere = (ctx.typeDeclarations?.[ctx.callerFile] ?? []).some(
    (fact) => fact.typeId === selfId && !fact.reopens,
  );
  return declaredHere ? impls.filter((impl) => impl.relPath === ctx.callerFile).flatMap((impl) => impl.traits) : [];
}

/** `traits` closed over their supertraits, read from the run's trait declaration facts. */
function rustWithSupertraits(traits: readonly string[], ctx: CallContext): ReadonlySet<string> {
  const closed = new Set<string>();
  const pending = [...traits];
  const { supertraitsByName } = rustTraitFactIndex(ctx);
  for (let trait = pending.pop(); trait !== undefined; trait = pending.pop()) {
    if (closed.has(trait)) continue;
    closed.add(trait);
    pending.push(...(supertraitsByName.get(trait) ?? []));
  }
  return closed;
}

interface RustTraitImplRecord {
  readonly relPath: string;
  readonly traits: readonly string[];
}

interface RustTraitFactIndex {
  /** Trait short name → its supertraits' short names, every declaring file merged. */
  readonly supertraitsByName: ReadonlyMap<string, readonly string[]>;
  /** Self type short name → its trait impls, with the declaring file. */
  readonly implsBySelfName: ReadonlyMap<string, readonly RustTraitImplRecord[]>;
}

const TRAIT_FACT_INDEX = new RunScopedMemo<object, { files: number; index: RustTraitFactIndex }>();
const EMPTY_TRAIT_FACT_INDEX: RustTraitFactIndex = { supertraitsByName: new Map(), implsBySelfName: new Map() };

/**
 * The run's trait declaration and trait impl facts, indexed by short name.
 * Memoised per resolve run and rebuilt when the facts map's file count moves:
 * the run state fills that map in place while it absorbs files.
 */
function rustTraitFactIndex(ctx: CallContext): RustTraitFactIndex {
  const declarations = ctx.typeDeclarations;
  if (declarations === undefined) return EMPTY_TRAIT_FACT_INDEX;
  const files = Object.keys(declarations).length;
  const cached = TRAIT_FACT_INDEX.get(ctx.runScope, declarations);
  if (cached?.files === files) return cached.index;
  const supertraitsByName = new Map<string, string[]>();
  const implsBySelfName = new Map<string, RustTraitImplRecord[]>();
  for (const [relPath, facts] of Object.entries(declarations)) {
    for (const fact of facts) {
      if (fact.conforms === undefined) continue;
      const name = shortNameOf(fact.typeId);
      const traits = fact.conforms.map(shortNameOf);
      if (fact.reopens) {
        const impls = implsBySelfName.get(name) ?? [];
        impls.push({ relPath, traits });
        implsBySelfName.set(name, impls);
      } else if (fact.symbolKind === "interface") {
        supertraitsByName.set(name, [...(supertraitsByName.get(name) ?? []), ...traits]);
      }
    }
  }
  const index = { supertraitsByName, implsBySelfName };
  TRAIT_FACT_INDEX.set(ctx.runScope, declarations, { files, index });
  return index;
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
