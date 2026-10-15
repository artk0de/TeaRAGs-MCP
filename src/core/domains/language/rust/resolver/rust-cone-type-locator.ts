import {
  pickSingleCandidate,
  type CallContext,
  type RelPath,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../contracts/types/language.js";
import { lookupRustSymbolsByShortName, type ResolverConfig } from "./strategies/shared.js";

/** Rust primitives for the kernel CHA cone: local impl methods are direct members. */
export class RustConeTypeLocator implements ConeTypeLocator {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null {
    const type = this.findType(typeName, ctx);
    return type?.relPath ?? null;
  }

  /** Rust structs/enums are runtime dispatch owners; traits are contracts only. */
  isRuntimeDispatchClass(typeName: string, ctx: CallContext): boolean {
    // Rust trait objects use a trait type as the static receiver; the runtime
    // targets are the concrete implementers, so the receiver itself is not a
    // dispatch class. Concrete structs and enums remain eligible owners.
    const type = this.findType(typeName, ctx);
    return type?.symbolKind === "class" || type?.symbolKind === "enum";
  }

  /** The cone's direct subtype lookup must not treat a trait declaration as an impl target. */
  findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const candidates = lookupRustSymbolsByShortName(ctx, member).filter(
      (definition) => isRustMemberOf(definition, typeName, member) && definition.scope.at(-1) === typeName,
    );
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target === null ? null : { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  }

  private findType(typeName: string, ctx: CallContext): SymbolDefinition | null {
    const candidates = lookupRustSymbolsByShortName(ctx, typeName).filter(
      (definition) => definition.symbolId === typeName || definition.symbolId.endsWith(`::${typeName}`),
    );
    return pickSingleCandidate(candidates, this.cfg.mode);
  }
}

function isRustMemberOf(definition: SymbolDefinition, typeName: string, member: string): boolean {
  return (
    definition.symbolId === `${typeName}#${member}` ||
    definition.symbolId === `${typeName}.${member}` ||
    definition.symbolId.endsWith(`::${typeName}#${member}`) ||
    definition.symbolId.endsWith(`::${typeName}.${member}`)
  );
}
