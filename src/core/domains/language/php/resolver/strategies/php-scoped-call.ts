import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type {
  ImportFileMapper,
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../contracts/types/language.js";
import { PhpImportFileMapper } from "../php-import-file-mapper.js";
import { classShortName, enclosingOwner, lookupPhpMemberInFile, type ResolverConfig } from "./shared.js";

/**
 * `Bar::make()` and `self::make()`.
 *
 * Same-file first: the member on `Bar` (or the enclosing class, for `self`
 * and `static`) in the caller file. Otherwise a `use` whose last segment is
 * `Bar`, mapped to the one project file the index holds. A matched scope
 * whose member is absent DROPs. An unmatched receiver CONTINUEs, and
 * `qualifiedReceiver` drops it.
 */
export class PhpScopedCallSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "scopedCall";

  constructor(
    _cfg: ResolverConfig,
    private readonly mapper: ImportFileMapper = new PhpImportFileMapper(),
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver === null || call.receiver.startsWith("$")) return CONTINUE;
    if (call.receiver === "self" || call.receiver === "static") {
      const owner = enclosingOwner(ctx.callerScope);
      if (owner === null) return DROP;
      const hit = lookupPhpMemberInFile(owner, call.member, ctx.callerFile, ctx);
      return hit ? resolved(hit) : DROP;
    }
    const local = lookupPhpMemberInFile(call.receiver, call.member, ctx.callerFile, ctx);
    if (local) return resolved(local);
    if (typeDefinedInFile(call.receiver, ctx.callerFile, ctx)) return DROP;
    const imported = importedFile(call.receiver, ctx, this.mapper);
    if (imported.kind === "none") return CONTINUE;
    if (imported.kind === "unpinned") return DROP;
    const hit = lookupPhpMemberInFile(call.receiver, call.member, imported.relPath, ctx);
    return hit ? resolved(hit) : DROP;
  }
}

function typeDefinedInFile(name: string, relPath: string, ctx: CallContext): boolean {
  return ctx.symbolTable.lookup(name).some((def) => {
    if (def.relPath !== relPath) return false;
    return (
      def.symbolKind === undefined ||
      def.symbolKind === "class" ||
      def.symbolKind === "interface" ||
      def.symbolKind === "enum"
    );
  });
}

function importedFile(
  receiver: string,
  ctx: CallContext,
  mapper: ImportFileMapper,
): { kind: "file"; relPath: string } | { kind: "none" } | { kind: "unpinned" } {
  const matches = ctx.imports.filter((imp) => classShortName(imp.importText) === receiver);
  if (matches.length === 0) return { kind: "none" };
  const files = new Set<string>();
  for (const imp of matches) {
    const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "project") files.add(mapped.relPath);
  }
  const [file] = files;
  if (files.size === 1 && file !== undefined) return { kind: "file", relPath: file };
  return { kind: "unpinned" };
}
