import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, CallResultBinding } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { resolveRustNominalType } from "./declared-return-type.js";
import { lookupRustSymbolsByShortName, rustImportBindings } from "./strategies/shared.js";

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

/** Consume only the walker's proven single-assignment channel and an exact same-file free-function return. */
export function rustDeclaredCallResultType(
  receiverName: string | null,
  atLine: number,
  ctx: CallContext,
): TypeRef | undefined {
  if (receiverName === null) return undefined;
  const binding = rustCallResultBindingOf(receiverName, atLine, ctx);
  if (binding === undefined) return undefined;
  if (
    ctx.imports.some((imp) => {
      const importBindings = rustImportBindings(imp.importText);
      return (
        importBindings === null ||
        importBindings.some((importBinding) => importBinding.globImport || importBinding.localName === binding.callee)
      );
    })
  ) {
    return undefined;
  }

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
  const candidates = lookupRustSymbolsByShortName(ctx, binding.callee).filter(
    (def) =>
      def.relPath === ctx.callerFile &&
      def.shortName === binding.callee &&
      def.symbolKind === "function" &&
      def.scope.length === moduleScope.length &&
      def.scope.every((name, index) => name === moduleScope[index]),
  );
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
  const placed = resolveRustNominalType(declaredReturnType, { ...ctx, callerScope: calleeDefinition.scope });
  const sameFile = (recv: TypeRef): boolean =>
    (recv.form === "instance" || recv.form === "class") &&
    recv.name.startsWith(`${calleeDefinition.relPath}::`) &&
    (recv.args?.every(sameFile) ?? true);
  return placed !== undefined && sameFile(placed) ? placed : undefined;
}
