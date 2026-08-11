/**
 * "Does this call site leave the project?" — the TypeScript answer, in one
 * place (bd tea-rags-mcp-ykj7, hoisted out of `TSCallResolver` for
 * bd tea-rags-mcp-6b3gj).
 *
 * It used to be a private method on the resolver, reachable only through
 * `TSCallResolver#targetsExternalImport`, and the provider called it only on
 * calls the chain had ALREADY declined — a post-hoc miss classifier. That
 * ordering is what produced the defect this module exists to fix: the
 * short-name passes (`globalShortName`, `importNarrowedFallback`) match a bare
 * member name against the whole symbol table, so `arr.push()` resolved to
 * whatever single project symbol happened to be called `push` LONG before
 * anything asked whether the receiver was an Array. The classifier never ran,
 * because from the chain's point of view the call had succeeded.
 *
 * The same predicate now runs BEFORE those two passes as a guard, so one
 * definition answers both questions — whether to emit an edge, and whether the
 * call belongs in the internal `resolveSuccessRate` denominator. Keeping them
 * in sync matters: a call we decline BECAUSE it targets `Array.prototype.push`
 * must also be counted external, or the resolver is penalised for being right.
 */

import type ts from "typescript";

import { resolveLocalBindingType, type CallContext, type CallRef } from "../../../../contracts/types/codegraph.js";
import {
  BARE_GLOBAL_CALLABLES,
  ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS,
  ECMASCRIPT_BUILTIN_TYPES,
  ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS,
  ECMASCRIPT_GLOBALS,
} from "../../shared/ecmascript-globals.js";
import { findReceiverExpression } from "./strategies/ts-type-checker-shared.js";
import { importSpecifierNamesReceiver } from "./ts-import-basename-match.js";
import { calleeIsExternalLocalBinding } from "./ts-local-callee.js";
import { mapImportToFile, type ProjectFileProbe, type TsCompilerOptions } from "./ts-path-mapper.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/**
 * `true` when the call provably — or, for an untyped receiver, near-certainly —
 * targets something outside the project. Four cases:
 *
 *   1. the receiver is an ECMAScript ambient global (`Math.max`, `console.log`
 *      — no import to match);
 *   2. the receiver / member binds to an import whose specifier does NOT map to
 *      a project file (`node:fs`, bare npm packages) — `mapImportToFile`
 *      returns `null` for exactly those (relative + tsconfig-`paths` resolve);
 *   3. the receiver's declared TYPE is an ECMAScript runtime builtin (`Map`,
 *      `Set`, `Promise`, typed arrays, …): `m.get()`, `this.pending.set()`,
 *      `p.then()` target the JS runtime instance method, not an in-repo symbol;
 *   4. the receiver carries NO type information at all AND the member is a word
 *      from the builtin-only prototype vocabulary (`push`, `splice`, `flatMap`,
 *      …) — see {@link ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS} for why that set
 *      is deliberately small;
 *   4b. the type checker finds the receiver's type DECLARED outside the
 *      project's own sources — a builtin, a default-lib type, or an npm
 *      package's — see {@link checkerTypesReceiverOutsideProject}. Reached both
 *      by receivers nothing could type (with the vocabulary having declined
 *      too) and by receivers the walker DID annotate with a name the project
 *      declares nothing by (bd tea-rags-mcp-3somv);
 *   5. the receiver is an imported project CONSTANT and the member is a builtin
 *      container operation (`YARD_CONST.test(t)`, `CODE_LANGUAGES.has(l)`) —
 *      see {@link receiverIsImportedBuiltinContainer};
 *   6. there is NO receiver, and the bare callee is a local value binding whose
 *      call signatures are all declared outside the project — a hook return
 *      (`useState`'s setter, `t`, `navigate`), see
 *      {@link calleeIsExternalLocalBinding} (bd tea-rags-mcp-qdjfu);
 *   7. there is NO receiver, and the member name is a JS/Node/browser ambient
 *      global callable with no project-local declaration possible — see
 *      {@link BARE_GLOBAL_CALLABLES} (bd tea-rags-mcp-4008o). Case 6 only
 *      covers LOCAL value bindings (closures, hook returns); this is the
 *      arm for a TRUE ambient global (`parseInt`, `fetch`, `setTimeout`),
 *      whose declaration lives in `lib.es5.d.ts` / `lib.dom.d.ts`, never in
 *      any file this project owns.
 *
 * PRECISION: cases 3 and 4 are mutually exclusive BY CONSTRUCTION, and that is
 * the load-bearing detail. A receiver whose type IS known decides the question
 * outright — a project-typed receiver is internal even when its member is
 * called `push`, and never falls through to the vocabulary. Case 4 only ever
 * sees receivers nothing in the chain could type.
 *
 * `programCache` is optional because the guard predates it and because
 * `CODEGRAPH_TS_TYPECHECKER=0` sets it to `null`; absent, cases 1-5 answer
 * exactly what they answered before it existed.
 */
export function targetsExternalImport(
  call: CallRef,
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  programCache: TSProgramCache | null = null,
  fileExists?: ProjectFileProbe,
): boolean {
  // `?? null` rather than a bare destructure: this now runs on EVERY call
  // reaching the short-name passes, not only on the ones already known to have
  // a receiver, and a free call carries no receiver at all.
  const receiver = call.receiver ?? null;
  if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
  // case 7: a bare call to a known ambient global function/constructor —
  // parseInt(x), fetch(url), setTimeout(fn) — no receiver, so cases 1-5 never
  // see it, and case 6 only covers LOCAL value bindings (closures, hook
  // returns), never a true ambient declared outside any file this project
  // owns (bd tea-rags-mcp-4008o).
  if (receiver === null && BARE_GLOBAL_CALLABLES.has(call.member)) return true;
  // Receiver-bound external, or a bare named import called directly
  // (`import { readFile } from "node:fs"` → `readFile()`).
  const boundName = receiver ?? call.member;
  if (boundName.length === 0) return false;
  for (const imp of ctx.imports) {
    if (
      imp.importedNames?.includes(boundName) &&
      mapImportToFile(imp.importText, ctx.callerFile, tsOptions, fileExists) === null
    ) {
      return true;
    }
  }
  // Case 5 is asked FIRST purely for cost: it reads the symbol table and the
  // import list, while case 4b may build a `ts.Program`. Both are pure
  // predicates, so the order changes only what gets paid for, never the answer.
  // Case 6 is LAST because it is the only arm a BARE call can reach — the two
  // before it return early without a receiver — so ordering it here costs a
  // receiver-bearing call nothing.
  return (
    receiverIsImportedBuiltinContainer(call, ctx) ||
    receiverIsExternalInstance(call, ctx, tsOptions, programCache, fileExists) ||
    calleeIsExternalLocalBinding(call, ctx, programCache)
  );
}

/**
 * Case 5 of {@link targetsExternalImport} (bd tea-rags-mcp-4kx9f): the receiver
 * is a CONSTANT this project imports, and the member is an operation on the
 * builtin container it holds.
 *
 * The four cases above cannot reach this shape. `ECMASCRIPT_GLOBALS` matches
 * receiver TEXT, and the receiver here is a project name. The import-specifier
 * case asks whether the specifier leaves the project, and this one does not —
 * it maps to the file that DECLARES the constant, which is precisely why the
 * import-mapping passes were emitting an edge onto that file. And no type is
 * recorded for it: the walker types locals and fields in the CALLER's file,
 * while the constant's initializer lives in the file it was imported from.
 *
 * So the evidence is the pair of facts that remain. The receiver is bound by an
 * import — by name, or by the basename convention the strategies match on. And
 * nothing declares that receiver as a symbol: `tsNameOf` names classes,
 * functions and methods, so a bound name the table does not know is a
 * module-level `const`, never a class. Only then does
 * {@link ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS} get a vote, which is what lets
 * that set carry words the last-resort vocabulary could not afford.
 *
 * `this` / `super` are excluded for the reason they always are — a self-call is
 * an earlier pass's business, and no import binds them.
 */
function receiverIsImportedBuiltinContainer(call: CallRef, ctx: CallContext): boolean {
  const receiver = call.receiver ?? null;
  if (receiver === null || receiver.length === 0 || receiver === "this" || receiver === "super") return false;
  if (!ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS.has(call.member)) return false;
  if (ctx.symbolTable.lookup(receiver).length > 0) return false;
  return ctx.imports.some(
    (imp) => imp.importedNames?.includes(receiver) || importSpecifierNamesReceiver(imp.importText, receiver),
  );
}

/**
 * TypeScript's own type-level operators — the complete `type X<…> = …` list
 * from `lib.es5.d.ts`, which is where every one of them is declared.
 *
 * These are not types in the sense the guard below needs. Each is a FUNCTION
 * over types, and the name records which transformation was applied, not what
 * the value is: `Awaited<ReturnType<EmbeddingProvider["embedBatch"]>>` is an
 * array of numbers, and the name says `Awaited`. So a receiver annotated with
 * one carries no nominal information at all, and treating the name as a type
 * the guard may decide on is what produced the measured defect
 * (bd tea-rags-mcp-yjqi5).
 *
 * Distinct from the exclusion noted on {@link ECMASCRIPT_BUILTIN_TYPES}: that
 * set omits these because they are not BUILTIN INSTANCES. This set says the
 * stronger thing — they are not evidence either way. `ReadonlyMap` /
 * `ReadonlySet` / `ReadonlyArray` are deliberately absent here for exactly that
 * reason: they have no runtime constructor either, but they DENOTE a builtin
 * instance, so they belong in the builtin set and decide outright.
 */
const TS_UTILITY_TYPES: ReadonlySet<string> = new Set([
  // Object shape transformations
  "Partial",
  "Required",
  "Readonly",
  "Record",
  "Pick",
  "Omit",
  // Union filters
  "Exclude",
  "Extract",
  "NonNullable",
  "NoInfer",
  // Function / constructor introspection
  "Parameters",
  "ConstructorParameters",
  "ReturnType",
  "InstanceType",
  "ThisParameterType",
  "OmitThisParameter",
  // Promise unwrapping
  "Awaited",
  // String-literal transformations
  "Uppercase",
  "Lowercase",
  "Capitalize",
  "Uncapitalize",
]);

/**
 * Cases 3, 4 and 4b of {@link targetsExternalImport}: does the RECEIVER belong
 * to something outside this project — a JS runtime builtin, a default-lib type,
 * or a dependency's?
 *
 * A known type answers definitively — builtin name means external, a project
 * class means internal. Only when no type can be resolved does the member-name
 * vocabulary get a vote, and then only for words that carry no comparably-common
 * project meaning.
 *
 * "Known" has to mean NOMINALLY known, which is what
 * {@link receiverNamesTypeLevelOperator} enforces: an annotation naming a TS
 * type-level operator is recorded by the walker like any other, but it pins no
 * runtime object, so it must not be allowed to decide the question outright.
 * Before that check, `const survivorEmbeddings: Awaited<…> = []` read as "type
 * known, not a builtin" — internal — and `survivorEmbeddings.push(e)` went on
 * to match the single project symbol named `push`.
 *
 * `this` / `super` receivers are excluded outright: those are self- and
 * inherited calls that earlier passes own, and a class with a method named
 * `push` is an ordinary thing to write.
 *
 * The checker arm (bd tea-rags-mcp-335eu, widened by bd tea-rags-mcp-otm6n and
 * again by bd tea-rags-mcp-3somv) is strictly LAST, and it can only ever ADD an
 * external verdict, never withdraw one — a checker answer of "declared in the
 * project" leaves the previous verdict standing.
 *
 * What reaches it changed with bd tea-rags-mcp-3somv. The walker-typed branch
 * used to decide by NAME alone: not an `ECMASCRIPT_BUILTIN_TYPES` member meant
 * "an ordinary project type", so `native: Parser.SyntaxNode` and
 * `response: Response` were ruled INTERNAL and `globalShortName` went on to
 * match the bare member against the whole symbol table. On a project that owns
 * a deliberate look-alike of an external type — `src/core/infra/materialize.ts`
 * mirrors tree-sitter's `SyntaxNode` interface on purpose — that match lands on
 * the look-alike, which is coincidence of SHAPE, never dispatch.
 *
 * So the branch now asks where the ANNOTATION comes from rather than what it is
 * called. A builtin name is external; {@link annotationOrigin} settles every
 * imported name from the import list alone, in both directions and for free.
 * Only an annotation nothing imports and no project declaration backs reaches
 * the checker, which answers by where the type LIVES. That keeps the recall
 * surface off every annotated receiver (the reason this branch was left alone
 * before) and keeps the checker off all but a residue. A project that declares
 * its own `Response` keeps deciding by type — the declaration is proof the name
 * means that class here.
 *
 * The member-name vocabulary stays unreachable for an annotated receiver, which
 * is the mutual exclusion cases 3 and 4 rest on: a project-typed receiver with
 * a method called `push` must stay internal.
 */
function receiverIsExternalInstance(
  call: CallRef,
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  programCache: TSProgramCache | null,
  fileExists?: ProjectFileProbe,
): boolean {
  const receiver = call.receiver ?? null;
  if (receiver === null || receiver.length === 0 || receiver === "this" || receiver === "super") return false;
  const typeName = receiverTypeName(call, ctx);
  if (typeName !== undefined && !receiverNamesTypeLevelOperator(typeName, ctx)) {
    if (ECMASCRIPT_BUILTIN_TYPES.has(typeName)) return true;
    // The name is not a builtin — which is NOT the same as "a project type"
    // (bd tea-rags-mcp-3somv). Where the annotation was IMPORTED from settles
    // it outright and for free; only a name no import binds and no project
    // declaration backs is worth a Program. The member-name vocabulary stays
    // unreachable either way, preserving the mutual exclusion cases 3 and 4
    // rest on.
    const origin = annotationOrigin(typeName, ctx, tsOptions, fileExists);
    if (origin !== "unbound") return origin === "package";
    if (ctx.symbolTable.lookup(typeName).length > 0) return false;
  } else if (ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS.has(call.member)) {
    return true;
  }
  return programCache !== null && checkerTypesReceiverOutsideProject(call, ctx, programCache);
}

/** Where the import list says a receiver's annotated TYPE comes from. */
type TSAnnotationOrigin = "project" | "package" | "unbound";

/**
 * Read the receiver's ANNOTATION the way case 2 of {@link targetsExternalImport}
 * reads the receiver itself: by asking whether the import that binds the name
 * maps into the project (bd tea-rags-mcp-3somv).
 *
 * This is the cheap half of the annotated-receiver question, and it answers
 * most of it. `native: Parser.SyntaxNode` and `multibar: MultiBar` name types
 * bound by bare specifiers — `mapImportToFile` returns `null` for exactly those
 * — so the annotation ITSELF says the receiver is a dependency's, which is
 * stronger evidence than any shape match and needs no `ts.Program` to read. The
 * mirror case is just as decisive: a specifier that resolves to a project file
 * means the author annotated with a project type, and the edge stands.
 *
 * The ROOT of a dotted annotation is what an import can bind — `Parser` in
 * `Parser.SyntaxNode`, never the qualified name.
 *
 * `unbound` is the honest third answer, not a default: a name nothing imports
 * is either declared locally or a global the default lib provides, and only
 * those two are worth paying the checker to tell apart. `Response` is the
 * reason that residue cannot simply be called "project".
 */
function annotationOrigin(
  typeName: string,
  ctx: CallContext,
  tsOptions: TsCompilerOptions,
  fileExists?: ProjectFileProbe,
): TSAnnotationOrigin {
  const rootName = typeName.split(".")[0];
  for (const imp of ctx.imports) {
    if (!imp.importedNames?.includes(rootName)) continue;
    return mapImportToFile(imp.importText, ctx.callerFile, tsOptions, fileExists) === null ? "package" : "project";
  }
  return "unbound";
}

/**
 * Case 4b (bd tea-rags-mcp-335eu, widened by bd tea-rags-mcp-otm6n): ask the
 * type checker what the receiver IS, for the receivers nothing else could type.
 *
 * Root causes 2 and 3 of bd tea-rags-mcp-yjqi5 are one gap seen twice. A Map
 * obtained from a call (`const map = this.ensureLoaded()`), a module-level
 * `new Map()` with no annotation, a field annotated `Map<…> | null`, an
 * intermediate expression (`seconds.toString()`) — none of them carries an
 * annotation the walker records, so {@link receiverTypeName} returns nothing and
 * the guard fell through to a vocabulary that deliberately excludes `set` /
 * `get` / `toString`, because those collide with real project methods. The type
 * is knowable for every one of them; only not from AST shape.
 *
 * This is NOT a chain reorder. `typeCheckerReturnType` (pass 12) can type the
 * same `const map = readRegistry()` receiver, but it runs AFTER
 * `globalShortName` (pass 9), so the bare short-name match has already
 * committed. bd tea-rags-mcp-pmxuv measured what moving a pass costs (-156
 * edges on this corpus), so the cache is threaded into the GUARD instead: a
 * yes/no gate that runs before matching, not a resolution attempt that changes
 * who answers.
 *
 * Precision comes from asking a question with only one safe answer. The checker
 * says "external" only when EVERY constituent of the receiver's type is DECLARED
 * outside the project's own sources — so `any`, an unresolved import, an
 * anonymous object type and every project class all yield `false` and leave the
 * previous verdict standing.
 *
 * WIDENED (bd tea-rags-mcp-otm6n) from "is this receiver's type a KNOWN BUILTIN
 * declared outside the project" to the question above. The narrow form left a
 * residual it could not reach by construction: `MapIterator` and `Response` are
 * real default-lib types that {@link ECMASCRIPT_BUILTIN_TYPES} does not
 * enumerate, and an npm package type is not a builtin at all — so closing them
 * by NAME would mean growing that set with every dependency a project happens to
 * install. Where the type is declared answers all three shapes at once, and it is
 * the question `targetsExternalImport` is named after.
 */
function checkerTypesReceiverOutsideProject(call: CallRef, ctx: CallContext, programCache: TSProgramCache): boolean {
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return false;
  const receiver = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  if (receiver === null) return false;
  return typeDeclaredOutsideProject(handle.checker, handle.checker.getTypeAtLocation(receiver), programCache);
}

/**
 * Is EVERY constituent of `type` declared entirely outside the project's own
 * sources?
 *
 * A union is walked constituent by constituent, and one in-project constituent
 * sinks the verdict: `Map<string, T> | ProjectStore` may reach the project on
 * this call, so declining it would trade a fabricated edge for a lost one. A
 * type declared in BOTH places — an interface the project merges into a
 * dependency's — is in-project for the same reason.
 *
 * Two answers deliberately mean "no evidence" rather than "external", because
 * this arm may only ever ADD an external verdict. A type with no symbol is
 * `any`, an unresolved import, or an anonymous shape the checker never named. A
 * symbol with no declarations is synthetic — the checker built it, no source
 * declares it — and a guard that read absence of declarations as "declared
 * elsewhere" would decline calls on no evidence at all.
 *
 * Nullable annotations need no special case, which is worth stating because it
 * looks like an omission. `parallel-synchronizer.ts:216` writes
 * `Map<string, FileMetadata> | null`, but the Programs this guard reads are
 * built by `buildCompilerOptions` WITHOUT `strictNullChecks`, so `null` and
 * `undefined` are absorbed rather than carried as constituents and the checker
 * reports the bare `Map`. A union that survives to here is a genuine multi-type
 * union.
 *
 * {@link TSProgramCache.isProjectSourceFile} is the load-bearing half, and it is
 * NOT the same test as a non-null `toRelPath`: `node_modules` sits inside the
 * repo root, so a repo-root-relative path counts every dependency — and, where
 * the compiler resolves under that root, every BUILTIN — as project code. A
 * project that declares its own `class Map` still keeps its edges: the checker
 * resolves that receiver to the project declaration and this returns `false`.
 */
function typeDeclaredOutsideProject(checker: ts.TypeChecker, type: ts.Type, programCache: TSProgramCache): boolean {
  for (const constituent of type.isUnion() ? type.types : [type]) {
    const symbol = checker.getApparentType(constituent).getSymbol();
    if (symbol === undefined) return false;
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length === 0) return false;
    if (declarations.some((declaration) => programCache.isProjectSourceFile(declaration.getSourceFile().fileName))) {
      return false;
    }
  }
  return true;
}

/**
 * `true` when the recorded type name is one of TypeScript's type-level
 * operators AND nothing in the project declares a symbol by that name.
 *
 * The symbol-table half is the same evidence
 * {@link receiverIsImportedBuiltinContainer} leans on, used the same way: these
 * names are ordinary identifiers, and a project is free to own one. A repo with
 * its own `class Record` or `class Parameters` keeps deciding by TYPE — the
 * declaration is proof the name means that class here, and suppressing it would
 * trade a fabricated edge for a lost one.
 */
function receiverNamesTypeLevelOperator(typeName: string, ctx: CallContext): boolean {
  return TS_UTILITY_TYPES.has(typeName) && ctx.symbolTable.lookup(typeName).length === 0;
}

/**
 * The receiver's declared type name, or `undefined` when nothing in the walker's
 * output pins one.
 *
 *   - `this.<field>.x()` → field type from `ctx.classFieldTypes[scope][field]`
 *     (mirrors `TSFieldTypeSymbolResolutionStrategy`); a chained
 *     `this.a.b.x()` is out of scope (one level only).
 *   - bare `<name>.x()` → walker-bound local type via `resolveLocalBindingType`
 *     (mirrors `TSLocalBindingSymbolResolutionStrategy`).
 */
function receiverTypeName(call: CallRef, ctx: CallContext): string | undefined {
  const receiver = call.receiver ?? "";
  if (receiver.startsWith("this.")) {
    const fieldSegment = receiver.slice("this.".length);
    if (fieldSegment.includes(".") || ctx.callerScope.length === 0) return undefined;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    return ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
  }
  return resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) ?? undefined;
}
