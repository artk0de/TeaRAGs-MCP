import type {
  AmbiguousResolveMode,
  CallContext,
  SymbolDefinition,
  SymbolDefinitionKind,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { PHP_SCOPE_SEPARATOR } from "../../kernel.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
}

export const PHP_FUNCTION_KINDS: ReadonlySet<SymbolDefinitionKind> = new Set(["function"]);

export function enclosingOwner(scope: readonly string[]): string | null {
  if (scope.length === 0) return null;
  return scope.join(PHP_SCOPE_SEPARATOR);
}

export function isPhpFunctionSymbol(def: SymbolDefinition): boolean {
  if (def.symbolKind === "function") return true;
  if (def.symbolKind !== undefined) return false;
  return !def.symbolId.includes("#") && !def.symbolId.includes(".");
}

/** A receiverless call whose member is a short name. `Foo\bar()` is qualified. */
export function isBarePhpCall(member: string, receiver: string | null): boolean {
  return receiver === null && !member.includes(PHP_SCOPE_SEPARATOR);
}

/** `Foo\Bar` and `Bar` both name the class chunk `Bar`. */
export function classShortName(typeName: string): string {
  const parts = typeName.split(PHP_SCOPE_SEPARATOR);
  return parts[parts.length - 1] ?? typeName;
}

/** Instance form first. PHP methods are chunked with `#`; `.` is the static spelling. */
export function lookupPhpMemberInFile(
  owner: string,
  member: string,
  relPath: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  for (const symbolId of [`${owner}#${member}`, `${owner}.${member}`]) {
    const hit = ctx.symbolTable.lookup(symbolId).find((def) => def.relPath === relPath);
    if (hit) return { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId };
  }
  return null;
}
