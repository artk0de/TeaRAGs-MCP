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
  ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS,
  ECMASCRIPT_BUILTIN_TYPES,
  ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS,
  ECMASCRIPT_GLOBALS,
} from "../../shared/ecmascript-globals.js";
import { findReceiverExpression } from "./strategies/ts-type-checker-shared.js";
import { importSpecifierNamesReceiver } from "./ts-import-basename-match.js";
import { mapImportToFile, type TsCompilerOptions } from "./ts-path-mapper.js";
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
 *   4b. the receiver carries no type information the WALKER could see, the
 *      vocabulary does not know the member either, and the type checker names
 *      the receiver's type as a runtime builtin — see
 *      {@link checkerNamesBuiltinReceiverType};
 *   5. the receiver is an imported project CONSTANT and the member is a builtin
 *      container operation (`YARD_CONST.test(t)`, `CODE_LANGUAGES.has(l)`) —
 *      see {@link receiverIsImportedBuiltinContainer}.
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
): boolean {
  // `?? null` rather than a bare destructure: this now runs on EVERY call
  // reaching the short-name passes, not only on the ones already known to have
  // a receiver, and a free call carries no receiver at all.
  const receiver = call.receiver ?? null;
  if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
  // Receiver-bound external, or a bare named import called directly
  // (`import { readFile } from "node:fs"` → `readFile()`).
  const boundName = receiver ?? call.member;
  if (boundName.length === 0) return false;
  for (const imp of ctx.imports) {
    if (imp.importedNames?.includes(boundName) && mapImportToFile(imp.importText, ctx.callerFile, tsOptions) === null) {
      return true;
    }
  }
  // Case 5 is asked FIRST purely for cost: it reads the symbol table and the
  // import list, while case 4b may build a `ts.Program`. Both are pure
  // predicates, so the order changes only what gets paid for, never the answer.
  return receiverIsImportedBuiltinContainer(call, ctx) || receiverIsBuiltinInstance(call, ctx, programCache);
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
 * Cases 3 and 4 of {@link targetsExternalImport}: is the RECEIVER a JS runtime
 * builtin instance?
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
 * The checker arm (bd tea-rags-mcp-335eu) is strictly LAST. It sees only the
 * receivers the walker could not type AND the vocabulary does not recognise —
 * which is the residue by construction, since a known type has already decided
 * and a known member has already returned `true`. It can only ever ADD an
 * external verdict, never withdraw one, so the vocabulary's answers are
 * untouched and no edge this guard used to allow is newly suppressed by a
 * checker answer of "not a builtin".
 */
function receiverIsBuiltinInstance(call: CallRef, ctx: CallContext, programCache: TSProgramCache | null): boolean {
  const receiver = call.receiver ?? null;
  if (receiver === null || receiver.length === 0 || receiver === "this" || receiver === "super") return false;
  const typeName = receiverTypeName(call, ctx);
  if (typeName !== undefined && !receiverNamesTypeLevelOperator(typeName, ctx)) {
    return ECMASCRIPT_BUILTIN_TYPES.has(typeName);
  }
  if (ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS.has(call.member)) return true;
  return programCache !== null && checkerNamesBuiltinReceiverType(call, ctx, programCache);
}

/**
 * Case 4b (bd tea-rags-mcp-335eu): ask the type checker what the receiver IS,
 * for the receivers nothing else could type.
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
 * says "external" only when EVERY constituent of the receiver's type is a
 * builtin whose declaration lies outside the project — so `any`, an unresolved
 * import, an anonymous object type and every project class all yield `false`
 * and leave the previous verdict standing.
 */
function checkerNamesBuiltinReceiverType(call: CallRef, ctx: CallContext, programCache: TSProgramCache): boolean {
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return false;
  const receiver = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  if (receiver === null) return false;
  return typeIsBuiltinInstance(handle.checker, handle.checker.getTypeAtLocation(receiver), programCache);
}

/**
 * Is EVERY constituent of `type` an ECMAScript runtime builtin declared outside
 * the project?
 *
 * A union is walked constituent by constituent, and one non-builtin constituent
 * sinks the verdict: `Map<string, T> | ProjectStore` may reach the project on
 * this call, so declining it would trade a fabricated edge for a lost one.
 *
 * Nullable annotations need no special case, which is worth stating because it
 * looks like an omission. `parallel-synchronizer.ts:216` writes
 * `Map<string, FileMetadata> | null`, but the Programs this guard reads are
 * built by `buildCompilerOptions` WITHOUT `strictNullChecks`, so `null` and
 * `undefined` are absorbed rather than carried as constituents and the checker
 * reports the bare `Map`. A union that survives to here is a genuine multi-type
 * union.
 *
 * The out-of-project check is what makes matching on a NAME safe. A project that
 * declares its own `class Map` would otherwise have every `Map`-typed receiver
 * declined; here the checker resolves that receiver to the project declaration,
 * {@link TSProgramCache.toRelPath} reports a real `RelPath`, and the guard
 * declines to decide — the same evidence `TSStructuralTypingSymbolResolutionStrategy`
 * uses to tell an in-project declaration site from a `node_modules` one.
 */
function typeIsBuiltinInstance(checker: ts.TypeChecker, type: ts.Type, programCache: TSProgramCache): boolean {
  for (const constituent of type.isUnion() ? type.types : [type]) {
    const symbol = checker.getApparentType(constituent).getSymbol();
    if (symbol === undefined || !ECMASCRIPT_BUILTIN_TYPES.has(symbol.getName())) return false;
    if (declaredInProject(symbol, programCache)) return false;
  }
  return true;
}

/** Does any declaration of `symbol` live inside the indexed project? */
function declaredInProject(symbol: ts.Symbol, programCache: TSProgramCache): boolean {
  return (symbol.getDeclarations() ?? []).some(
    (declaration) => programCache.toRelPath(declaration.getSourceFile().fileName) !== null,
  );
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
