import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBinding,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import { PhpImportFileMapper } from "../php-import-file-mapper.js";
import { classShortName, lookupPhpMemberInFile, type ResolverConfig } from "./shared.js";

/**
 * `$repo->save()` when a local binding already names `$repo`'s type.
 *
 * The binding comes from the walker (`Greeter $repo`, `$repo = new Greeter()`).
 * No binding, or a primitive type, CONTINUEs so `qualifiedReceiver` still drops
 * the call. A known type that declares no such member DROPs: the type is
 * authoritative, and a function named `save` is not the answer.
 */
export class PhpTypedReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "typedReceiver";
  private readonly mapper = new PhpImportFileMapper();

  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!call.receiver?.startsWith("$")) return CONTINUE;
    const binding = resolveLocalBinding(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    const typeName = binding?.type;
    if (typeName === undefined || typeName === "") return CONTINUE;
    const short = classShortName(typeName);
    if (short === "" || capability.naming?.nonConceptTypes.includes(short)) return CONTINUE;
    const imported = typeName.includes("\\")
      ? this.mapper.mapImportToFile(typeName, ctx.callerFile, ctx)
      : { kind: "unknown" as const };
    if (imported.kind === "project") {
      const pinned = lookupPhpMemberInFile(short, call.member, imported.relPath, ctx);
      if (pinned) return resolved(pinned);
    }
    const candidates = [
      ...ctx.symbolTable.lookup(`${short}#${call.member}`),
      ...ctx.symbolTable.lookup(`${short}.${call.member}`),
    ];
    const local = candidates.filter((def) => def.relPath === ctx.callerFile);
    const hit = pickSingleCandidate(local.length > 0 ? local : candidates, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return DROP;
  }
}
