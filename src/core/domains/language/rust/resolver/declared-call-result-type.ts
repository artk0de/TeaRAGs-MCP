import { identifierEntry } from "../../../../contracts/identifier-record.js";
import {
  resolveLocalBinding,
  type CallContext,
  type CallResultBinding,
  type SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { rustTextIsStdValueWrapper } from "../vocabulary/std-prelude.js";
import { resolveRustNominalType } from "./declared-return-type.js";
import { rustPlaceTypeThroughDeclaringFile } from "./declaring-file-type.js";
import { rustExternalAssociatedCallType } from "./external-type-hops.js";
import { rustStdTypeRef, rustStdUnwrapType } from "./std-type-hops.js";
import {
  lookupRustSymbolsByShortName,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportIsExternal,
} from "./strategies/shared.js";

/**
 * The call-result binding of `receiverName` visible at `atLine` — the channel
 * read plus the proven-window guards, shared with the strategy-layer method
 * arm (`rustMethodCallResultType` in `strategies/rust-type-receiver.ts`).
 * Rust shadowing: among the bindings whose window `(endLine, scopeEndLine]`
 * holds the line, the latest `let` wins (bd tea-rags-mcp-2g2og.24).
 */
export function rustCallResultBindingOf(
  receiverName: string,
  atLine: number,
  ctx: CallContext,
): CallResultBinding | undefined {
  let visible: CallResultBinding | undefined;
  for (const binding of identifierEntry(ctx.callResultBindings, receiverName) ?? []) {
    // endLine + scopeEndLine distinguish this proven channel from dormant legacy evidence.
    if (
      binding.endLine === undefined ||
      binding.scopeEndLine === undefined ||
      atLine <= binding.endLine ||
      atLine > binding.scopeEndLine
    ) {
      continue;
    }
    if (visible === undefined || binding.line > visible.line) visible = binding;
  }
  return visible;
}

/** Consume only the walker's proven single-assignment channel and an exact free-function return. */
export function rustDeclaredCallResultType(
  receiverName: string | null,
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  if (receiverName === null) return undefined;
  const binding = rustCallResultBindingOf(receiverName, atLine, ctx);
  if (binding === undefined) return undefined;
  const callee = rustFreeFunctionReturn(binding.callee, ctx);
  if (callee === undefined) return rustExternalPathCallResultType(binding, ctx);
  const { calleeDefinition, declaredReturnType } = callee;
  if (
    (declaredReturnType.form !== "instance" && declaredReturnType.form !== "class") ||
    declaredReturnType.name === "Self"
  ) {
    return undefined;
  }
  // The return spelling means what the CALLEE's file means: placed in that
  // file's lexical scope (its imports are not loaded, so the placement veto
  // reads the caller's — it can only over-veto). The sameFile anchor below
  // keeps the answer in the callee's own file regardless, so a name the
  // callee bound from a third file declines instead of landing there.
  const owner = resolveRustNominalType(declaredReturnType, calleeContext(calleeDefinition, ctx));
  if (owner !== undefined && placedInFile(owner, calleeDefinition.relPath)) return owner;
  // A name the callee bound through `use` is placed through the callee
  // file's own imports (bd tea-rags-mcp-s3i8m letCall S4b). The argument list
  // travels only when every argument places the same way; otherwise the head
  // stays typed alone and a member needing an argument declines on its own.
  const imported = rustPlaceTypeThroughDeclaringFile(declaredReturnType.name, calleeDefinition.relPath, ctx);
  if (imported === undefined) return undefined;
  const typeArguments = declaredReturnType.args?.map((arg) =>
    arg.form === "instance" || arg.form === "class"
      ? rustPlaceTypeThroughDeclaringFile(arg.name, calleeDefinition.relPath, ctx)
      : undefined,
  );
  const head = { ...imported, form: declaredReturnType.form };
  return typeArguments === undefined || typeArguments.length === 0 || typeArguments.some((arg) => arg === undefined)
    ? head
    : { ...head, args: typeArguments as TypeRef[] };
}

/**
 * `Type::<..>::assoc(args)` followed only by `?` tails: the type spelling, the
 * associated function, the argument text and the `?`s.
 */
const RUST_PATH_CALL_INIT = /^(?:::)?((?:[A-Za-z_]\w*::)*[A-Z]\w*)(?:::<[^()]*>)?::([A-Za-z_]\w*)\((.*)\)(\?*)$/;
const RUST_LOCAL_NAME = /^[a-z_]\w*$/;

/**
 * A `let` bound from a path call on an external type (bd s3i8m.7 T3c):
 * `Vec::new()`, `Url::parse(s)?` answer the table's declared return, each `?`
 * unwrapping it. A std value wrapper's `new(x)` carries `x`'s type as its
 * argument when `x` is a typed local (`Arc::new(store)` → `Arc<Store>`).
 */
function rustExternalPathCallResultType(binding: CallResultBinding, ctx: CallContext): TypeRef | undefined {
  const match = RUST_PATH_CALL_INIT.exec(binding.initExpression ?? "");
  if (match === null) return undefined;
  const [, spelling, assoc, argumentText, tries] = match;
  if (!balancedParentheses(argumentText)) return undefined;
  let produced = rustExternalAssociatedCallType(spelling, assoc, ctx);
  if (
    produced?.form === "instance" &&
    produced.args === undefined &&
    assoc === "new" &&
    rustTextIsStdValueWrapper(produced.name)
  ) {
    const wrapped = rustTypedLocalType(argumentText.trim(), binding.line, ctx);
    if (wrapped !== undefined) produced = { ...produced, args: [wrapped] };
  }
  for (let i = 0; i < tries.length && produced !== undefined; i++) produced = rustStdUnwrapType(produced, "?");
  return produced;
}

/** The argument list closes only at its end: `f(a).g(b)` is no single call. */
function balancedParentheses(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * A bare local's type: its own call-result binding (the walker records none
 * for an annotated `let`), else its binding read as a placed project type or a
 * std spelling.
 */
function rustTypedLocalType(name: string, atLine: number, ctx: CallContext): TypeRef | undefined {
  if (!RUST_LOCAL_NAME.test(name) || name === "self") return undefined;
  const produced = rustDeclaredCallResultType(name, atLine, ctx);
  if (produced !== undefined) return produced;
  const binding = resolveLocalBinding(ctx.localBindings, name, atLine);
  if (binding === undefined || binding.valueKind === "patternProjection") return undefined;
  const typeRef = binding.typeRef ?? (binding.type ? { form: "instance" as const, name: binding.type } : undefined);
  if (typeRef?.form !== "instance") return undefined;
  return (
    resolveRustNominalType(typeRef, ctx) ??
    rustStdTypeRef(
      typeRef.name,
      typeRef.args?.map((arg) => resolveRustNominalType(arg, ctx)),
      ctx,
    )
  );
}

/**
 * The declared return of the free function a bare call `callee(…)` names,
 * placed in the callee's file (bd tea-rags-mcp-s3i8m, Task 1a) — the head of a
 * pattern's scrutinee (`let (tx, rx) = make_pair();`). A project type must
 * live in the callee's file; a std type travels as its std spelling; a tuple
 * is typed only when every element is.
 */
export function rustFreeCallResultType(callee: string, ctx: CallContext): TypeRef | undefined {
  const found = rustFreeFunctionReturn(callee, ctx);
  if (found === undefined) return undefined;
  const { calleeDefinition, declaredReturnType } = found;
  const declaringCtx = calleeContext(calleeDefinition, ctx);
  const place = (recv: TypeRef): TypeRef | undefined => {
    if (recv.form === "tuple") {
      const elements = recv.elements.map(place);
      return elements.every((element) => element !== undefined) ? { form: "tuple", elements } : undefined;
    }
    if ((recv.form !== "instance" && recv.form !== "class") || recv.name === "Self") return undefined;
    const typeArguments = recv.args?.map(place);
    const head = resolveRustNominalType({ form: recv.form, name: recv.name }, declaringCtx);
    if (head === undefined) return rustStdTypeRef(recv.name, typeArguments, declaringCtx);
    if (!placedInFile(head, calleeDefinition.relPath)) return undefined;
    return typeArguments === undefined || typeArguments.some((arg) => arg === undefined)
      ? head
      : { ...head, args: typeArguments as TypeRef[] };
  };
  return place(declaredReturnType);
}

function calleeContext(def: SymbolDefinition, ctx: CallContext): CallContext {
  return { ...ctx, callerScope: def.scope, callerFile: def.relPath };
}

function placedInFile(recv: TypeRef, relPath: string): boolean {
  return (
    (recv.form === "instance" || recv.form === "class") &&
    recv.name.startsWith(`${relPath}::`) &&
    (recv.args?.every((arg) => placedInFile(arg, relPath)) ?? true)
  );
}

/** The single free function `callee` names from the caller's lexical scope, with its declared return. */
function rustFreeFunctionReturn(
  callee: string,
  ctx: CallContext,
): { calleeDefinition: SymbolDefinition; declaredReturnType: TypeRef } | undefined {
  // Only the module prefix is a free function's lexical namespace, never a method/class frame.
  const moduleScope: string[] = [];
  for (const name of ctx.callerScope) {
    const id = [...moduleScope, name].join("::");
    const modules = ctx.symbolTable
      .lookup(id)
      .filter((def) => def.relPath === ctx.callerFile && def.symbolId === id && def.symbolKind === "module");
    if (modules.length !== 1) break;
    moduleScope.push(name);
  }
  // An import shadowing the name (glob, unparseable, or bound to it) makes the
  // same-file free function unreachable — it scopes the SAME-FILE arm only:
  // the cross-file arm below is itself import-bound, the shadow is its proof.
  const importShadows = ctx.imports.some((imp) => {
    const bindings = rustImportBindings(imp.importText);
    return (
      bindings === null ||
      bindings.some((importBinding) => importBinding.globImport || importBinding.localName === callee)
    );
  });
  const sameFileCandidates = importShadows
    ? []
    : lookupRustSymbolsByShortName(ctx, callee).filter(
        (def) =>
          def.relPath === ctx.callerFile &&
          def.shortName === callee &&
          def.symbolKind === "function" &&
          def.scope.length === moduleScope.length &&
          def.scope.every((name, index) => name === moduleScope[index]),
      );
  let candidates = sameFileCandidates;
  if (candidates.length === 0) candidates = crossFileCandidates(callee, ctx);
  if (candidates.length !== 1) return undefined;
  const calleeDefinition = candidates[0];
  const declaredReturnType = identifierEntry(
    ctx.structuredReturnTypes,
    `${calleeDefinition.relPath}::${calleeDefinition.symbolId}`,
  );
  return declaredReturnType === undefined ? undefined : { calleeDefinition, declaredReturnType };
}

/**
 * The cross-file free-function arm: the callee is bound by exactly ONE
 * non-glob, INTERNAL import (`use crate::makers::make;`), and exactly one
 * project function of that name lives across the paths that import names.
 * An external binding (`use external::make;`) proves nothing about where the
 * function lives, so it never reaches the structured return.
 */
function crossFileCandidates(callee: string, ctx: CallContext): SymbolDefinition[] {
  const bound = ctx.imports.filter((imp) => {
    const bindings = rustImportBindings(imp.importText);
    return bindings?.some((importBinding) => importBinding.localName === callee && !importBinding.globImport) === true;
  });
  if (bound.length !== 1) return [];
  if (rustImportIsExternal(bound[0].importText, ctx, callee)) return [];
  const paths = rustImportCandidatePaths(bound[0].importText, callee, ctx.callerFile, ctx);
  if (paths === null) return [];
  return lookupRustSymbolsByShortName(ctx, callee).filter(
    (def) => paths.includes(def.relPath) && def.relPath.endsWith(".rs") && def.symbolKind === "function",
  );
}
