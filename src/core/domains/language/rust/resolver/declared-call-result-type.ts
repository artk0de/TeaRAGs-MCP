import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, CallResultBinding, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { resolveRustNominalType } from "./declared-return-type.js";
import {
  lookupRustSymbolsByShortName,
  rustImportBindings,
  rustImportCandidatePaths,
  rustImportIsExternal,
} from "./strategies/shared.js";

/**
 * The validated single call-result binding behind `receiverName` — the channel
 * read plus the proven-window guards, shared with the strategy-layer method
 * arm (`rustMethodCallResultType` in `strategies/rust-type-receiver.ts`).
 */
export function rustCallResultBindingOf(
  receiverName: string,
  atLine: number,
  ctx: CallContext,
): CallResultBinding | undefined {
  const bindings = identifierEntry(ctx.callResultBindings, receiverName);
  if (bindings?.length !== 1) return undefined;
  const binding = bindings[0];
  // endLine + scopeEndLine distinguish this proven channel from dormant legacy evidence.
  if (
    binding.endLine === undefined ||
    binding.scopeEndLine === undefined ||
    atLine <= binding.endLine ||
    atLine > binding.scopeEndLine
  ) {
    return undefined;
  }
  return binding;
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
      bindings.some((importBinding) => importBinding.globImport || importBinding.localName === binding.callee)
    );
  });
  const sameFileCandidates = importShadows
    ? []
    : lookupRustSymbolsByShortName(ctx, binding.callee).filter(
        (def) =>
          def.relPath === ctx.callerFile &&
          def.shortName === binding.callee &&
          def.symbolKind === "function" &&
          def.scope.length === moduleScope.length &&
          def.scope.every((name, index) => name === moduleScope[index]),
      );
  let candidates = sameFileCandidates;
  if (candidates.length === 0) candidates = crossFileCandidates(binding.callee, ctx);
  if (candidates.length !== 1) return undefined;
  const calleeDefinition = candidates[0];
  const declaredReturnType = identifierEntry(
    ctx.structuredReturnTypes,
    `${calleeDefinition.relPath}::${calleeDefinition.symbolId}`,
  );
  if (
    declaredReturnType === undefined ||
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
  const owner = resolveRustNominalType(declaredReturnType, {
    ...ctx,
    callerScope: calleeDefinition.scope,
    callerFile: calleeDefinition.relPath,
  });
  const sameFile = (recv: TypeRef): boolean =>
    (recv.form === "instance" || recv.form === "class") &&
    recv.name.startsWith(`${calleeDefinition.relPath}::`) &&
    (recv.args?.every(sameFile) ?? true);
  return owner !== undefined && sameFile(owner) ? owner : undefined;
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
