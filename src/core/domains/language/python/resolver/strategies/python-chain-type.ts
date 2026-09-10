import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../../kernel/receiver-type-propagation.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "../python-receiver-type-ports.js";
import {
  lastSegment,
  resolvePythonMemberOnType,
  resolvePythonMemberOnTypeThroughMro,
  resolveTypeFile,
  type ResolverConfig,
} from "./shared.js";

/**
 * Typed-receiver resolution through the shared chain fold (E1 seam 3, bd
 * tea-rags-mcp-9fgdi).
 *
 * The entry condition is TYPEDNESS, not receiver shape — whatever
 * `propagateReceiverType` threads to a single class or instance, this pass
 * resolves the member on. Two shapes it exists for, neither of which any
 * earlier pass owns:
 *
 *   x = svc.build()   →   x.run()          binding → return type
 *   self.repo.get(id).save()                field → return → member
 *
 * `localBinding` needs the receiver itself to be bound and is terminal for
 * those it owns; `selfField` handles exactly ONE access level and CONTINUEs on
 * `self.foo.bar` (bd tea-rags-mcp-rjuc). Everything with a call or a second dot
 * in it reached `importedName` / `globalShortName` before this pass — those two
 * plus the since-removed `importMatch` produce 9,892 of the E0 baseline's
 * phantoms.
 *
 * **Three-state semantics:**
 *
 * - `CONTINUE` — the fold produced nothing, or a `union` / `container` with no
 *   single class to look up. The call reaches the later passes exactly as it
 *   does today; nothing regresses by absence.
 *
 * - `resolved(target)` — the folded type resolved to one in-project symbol for
 *   the member: on the type itself, up its C3 MRO, or (walker-v2 index, no
 *   hierarchy channel) up its `classExtends` chain. Terminal.
 *
 * - `DROP` — the folded type is known and is NOT in the project (builtin,
 *   stdlib, third-party), or is in the project but defines the member nowhere
 *   in its chain. NOTE the difference from `localBinding`, which commits a
 *   file-only edge in the second case: that fallback is measured for a DIRECT
 *   binding (bd tea-rags-mcp-86qfb) and unmeasured for a type arrived at by
 *   folding hops, and this program is precision-gated. If the oracle A/B shows
 *   `lost` concentrated on this shape, the file-only fallback is the fix — do
 *   not pre-emptively add it.
 *
 * **Chain placement:** AFTER `localBinding`, BEFORE `importedName`. Both
 * offline harnesses call `createPythonSymbolResolutionChain`, so the insertion
 * reaches them with no second edit (bd tea-rags-mcp-3yxmy).
 */
export class PythonChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "chainType";
  private readonly ports: ReceiverTypePorts;

  /**
   * `linearizers` is the run's ancestor-MRO cache (bd tea-rags-mcp-yl85b): the
   * fold reads `classFieldTypes` and `structuredReturnTypes` up the hierarchy,
   * and the memo holding that order belongs to the resolver, not to a call
   * site. Optional — a caller without one keeps the own-class-only read.
   */
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {
    // ONE ports object for the life of the resolver — the fold allocates
    // nothing per call site.
    this.ports = createPythonReceiverTypePorts(mapper, linearizers);
  }

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (!receiver) return CONTINUE;

    const type = propagateReceiverType(receiver, call.startLine, ctx, this.ports);
    if (!type || (type.form !== "class" && type.form !== "instance")) return CONTINUE;

    // The LAST hop resolves its member through the C3 MRO, exactly as the hops
    // before it read their field and return types (bd tea-rags-mcp-s2w5g).
    // `resolvePythonMemberOnType` below falls back to the single-base
    // `classExtends` chain with an UNFILTERED lookup on each hop, and polar
    // declares `BuildRequestMixin` twice — once in the SDK, once in the
    // generator template it is rendered from — so that lookup is ambiguous and
    // answers `null` on a member jedi pins exactly.
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer !== undefined) {
      const mro = resolvePythonMemberOnTypeThroughMro(
        type.name,
        call.member,
        ctx,
        this.cfg.mode,
        this.mapper,
        linearizer,
      );
      if (mro.target) return resolved(mro.target);
    }

    // A folded type whose file is not in the project is external — DROP rather
    // than hand the call to the short-name passes.
    if (resolveTypeFile(lastSegment(type.name), ctx, this.mapper) === null) return DROP;

    // The legacy walk stays below the MRO one, not replaced by it: the pass's
    // miss verdict is DROP either way, so keeping it costs no precision and
    // keeps every edge it already answered — including the ones whose type name
    // the MRO walk cannot address at all.
    const target = resolvePythonMemberOnType(type.name, call.member, ctx, this.cfg.mode, this.mapper);
    return target ? resolved(target) : DROP;
  }
}
