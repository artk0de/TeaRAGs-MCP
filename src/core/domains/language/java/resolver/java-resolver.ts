/**
 * Java implementation of the `CallResolver` contract. Relocated from
 * `domains/trajectory/codegraph/symbols/resolvers/java/java-resolver.ts` into
 * the native Java language provider per the `domains/language` consolidation
 * (spec §3; bd tea-rags-mcp-cen6). Behaviour-preserving.
 *
 * Java imports name fully-qualified types: `com.foo.Bar` →
 * `com/foo/Bar.java`. Wildcard imports (`com.foo.*`) point at a
 * package (directory) rather than a single file, so resolution
 * relies on the symbol table's short-name lookup restricted to that
 * directory.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) via the shared `resolveViaChain` engine. The
 * array order encodes precedence, and the four-state outcome
 * (resolved / deferred / drop / continue) makes the load-bearing guard drop explicit — a
 * receiver-present call that matches no import / binding / java.lang type DROPS
 * rather than falling through to the bare-call short-name lookup that would
 * fabricate a same-class false-positive edge (mirrors the TS `super` guard, bd
 * tea-rags-mcp-4rgg family).
 *
 * The pass order (each `name` in parens):
 *   1. thisMember        (this.X same-file enclosing member)
 *   2. fieldType         (this.field.X via declared field type)
 *   3. localBinding      (param.X / localVar.X via walker-bound type)
 *   4. importReceiver    (receiver via import / wildcard scope / java.lang — terminal guard)
 *   5. enclosingBareCall (bare foo() → enclosing-class member, same file)
 *   6. globalShortName   (terminal global short-name fallback)
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveImportFileEdges, resolveViaChain } from "../../kernel/index.js";
import { JavaImportFileMapper } from "./java-import-file-mapper.js";
import {
  JavaEnclosingBareCallSymbolResolutionStrategy,
  JavaFieldTypeSymbolResolutionStrategy,
  JavaGlobalShortNameSymbolResolutionStrategy,
  JavaImportReceiverSymbolResolutionStrategy,
  JavaLocalBindingSymbolResolutionStrategy,
  JavaThisMemberSymbolResolutionStrategy,
  mapJavaImportToFile,
  type ResolverConfig,
} from "./strategies/index.js";
import { javaImportMatchesReceiver } from "./strategies/java-import-receiver.js";

export { mapJavaImportToFile };

export class JavaCallResolver implements CallResolver {
  readonly language = "java";
  /** The ONE import → file answer the call chain and the file graph share. */
  private readonly importFileMapper = new JavaImportFileMapper();
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new JavaThisMemberSymbolResolutionStrategy(cfg),
      new JavaFieldTypeSymbolResolutionStrategy(cfg),
      new JavaLocalBindingSymbolResolutionStrategy(cfg),
      new JavaImportReceiverSymbolResolutionStrategy(cfg, this.importFileMapper),
      new JavaEnclosingBareCallSymbolResolutionStrategy(cfg),
      new JavaGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * File edges straight from the import → file seam (bd tea-rags-mcp-vfmfg).
   * The runner's default synthesised `{ receiver: Bar, member: Bar }` call
   * answered through `importReceiver`, whose file-only fallback named the
   * synthesised path — a file no Maven-layout project and no JDK import has.
   */
  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    return resolveImportFileEdges(extraction, this.importFileMapper, ctx);
  }

  /**
   * An UNRESOLVED call whose receiver is bound by an import the project holds
   * no file for — the call `importReceiver` drops as leaving the project.
   */
  targetsExternalImport(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null) return false;
    const match = ctx.imports.find((imp) => javaImportMatchesReceiver(imp.importText, receiver));
    return (
      match !== undefined &&
      this.importFileMapper.mapImportToFile(match.importText, ctx.callerFile, ctx).kind === "external"
    );
  }
}
