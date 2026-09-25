import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { swiftLexicallyReachedDefinitions } from "../swift-lexical-reach.js";
import {
  lookupSwiftBareNameDefinitions,
  narrowSwiftOverloads,
  pickSwiftOverload,
  swiftMemberCandidates,
} from "../swift-symbol-lookup.js";
import { isSwiftReopenedOnlyType } from "../swift-type-declarations.js";
import { isSwiftTypeDeclarationId, stripSwiftOverloadSuffix } from "../swift-type-name.js";
import type { SwiftResolverConfig } from "./shared.js";

/**
 * Terminal short-name fallback for BARE calls the enclosing-type passes did not
 * claim: a free function, or a type named by a construction expression
 * (`Repository()` is recorded as a bare call whose member is `Repository`, and
 * the type's own symbol is what it lands on).
 *
 * **It answers bare calls only, and that is the precision decision of this
 * chain.** Every other language reaches its short-name tail having first
 * narrowed a receiver through imports: Java's `importReceiver` drops what the
 * fully-qualified import table cannot place, TypeScript demands checker or
 * structural evidence before committing a member call. Swift has neither to
 * offer — `import Foundation` names a MODULE, never a symbol, so no import
 * ever narrows a receiver — which leaves a receiver-bearing call here with
 * exactly the evidence JavaScript's tail was measured on and found to have
 * none: every receiver-bearing edge it produced was fabricated
 * (bd tea-rags-mcp-hwwtw). So an unknown receiver emits NOTHING rather than the
 * project's lone namesake.
 *
 * That is also why the Swift chain builds no import-match strategy at all. One
 * could be written — match a receiver against an imported module name — but it
 * would only ever fire on `SomeModule.function()`, where the receiver is a
 * module rather than a value, and Swift's module-scoped functions are rare
 * enough that the pass would be almost pure fabrication risk.
 *
 * `pickSingleCandidate(mode)` returns the sole hit (strict) or the first
 * (legacy `first`). Non-decisive → continue; the chain then exhausts and emits
 * no edge.
 */
export class SwiftGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;
    // Only what Swift's unqualified lookup reaches from here (bd tea-rags-mcp-y99pg.39).
    const defs = swiftLexicallyReachedDefinitions(
      lookupSwiftBareNameDefinitions(ctx, call.member),
      call,
      ctx,
      this.cfg.memberTypes,
    );
    const reopened = reopenedOnlyConstruction(defs, ctx);
    if (reopened !== undefined) return this.extensionInitializer(reopened, call, ctx);
    // With the call's arguments on record, a file's `makeContext` /
    // `makeContext~2` are ONE function's overloads: the arguments narrow them,
    // and a same-file set is no ambiguity about where the target lives.
    // Without that evidence, or when no declaration fits, the cardinality gate
    // judges every declaration, as before.
    const fitting = call.argCount === undefined ? [] : narrowSwiftOverloads(call, defs);
    const hit =
      fitting.length > 0 ? pickSwiftOverload(fitting, this.cfg.mode) : pickSingleCandidate(defs, this.cfg.mode);
    if (!hit) return CONTINUE;
    return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
  }

  /**
   * A construction of a type the project only EXTENDS (bd tea-rags-mcp-y99pg.1,
   * .15). The SDK's initializer runs unless an extension declares one the
   * call's argument labels fit, and the edge then lands on the type in the
   * file declaring THAT initializer: `URLRequest(url:method:headers:)` reaches
   * `URLConvertible.swift`, not every file re-opening `URLRequest`. No fitting
   * initializer — `Result { try … }` runs the standard library's
   * `init(catching:)` — emits nothing.
   */
  private extensionInitializer(typeId: string, call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const inits = [
      ...swiftMemberCandidates(ctx, `${typeId}#init`, call),
      ...swiftMemberCandidates(ctx, `${typeId}.init`, call),
    ];
    const files = [...new Set(inits.map((def) => def.relPath))].sort();
    if (files.length === 0) return CONTINUE;
    if (files.length > 1 && this.cfg.mode === "strict") return CONTINUE;
    return resolved({ targetRelPath: files[0], targetSymbolId: typeId });
  }
}

/** The one type every `defs` entry declares when the project only re-opens it, else undefined. */
function reopenedOnlyConstruction(defs: readonly SymbolDefinition[], ctx: CallContext): string | undefined {
  if (defs.length === 0 || !defs.every((def) => isSwiftTypeDeclarationId(def.symbolId))) return undefined;
  const typeIds = new Set(defs.map((def) => stripSwiftOverloadSuffix(def.symbolId)));
  if (typeIds.size !== 1) return undefined;
  const [typeId] = typeIds;
  return isSwiftReopenedOnlyType(typeId, ctx) ? typeId : undefined;
}
