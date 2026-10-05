import type { AmbiguousResolveMode } from "../../../../../contracts/types/codegraph.js";
import {
  ChainTypeSymbolResolutionStrategy,
  createTypeMemberLookup,
  propagateReceiverType,
  type ReceiverTypingPorts,
  type TypeMemberLookup,
} from "../../../kernel/index.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "../python-receiver-type-ports.js";
import {
  resolvePythonMemberOnType,
  resolvePythonMemberOnTypeThroughMro,
  resolveTypeRefFile,
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
 *
 * The verdict is the kernel's `ChainTypeSymbolResolutionStrategy` (bd
 * tea-rags-mcp-m99j1.1.5); this class binds Python's fold as the typing port,
 * {@link createPythonChainTypeMemberLookup} as the member walk, and the
 * DROP-on-typed-miss policy above.
 */
export class PythonChainTypeSymbolResolutionStrategy extends ChainTypeSymbolResolutionStrategy {
  /**
   * `linearizers` is the run's ancestor-MRO cache (bd tea-rags-mcp-yl85b): the
   * fold reads `classFieldTypes` and `structuredReturnTypes` up the hierarchy,
   * and the memo holding that order belongs to the resolver, not to a call
   * site. Optional — a caller without one keeps the own-class-only read.
   */
  constructor(
    cfg: ResolverConfig,
    mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    linearizers?: PythonAncestorLinearizerCache,
  ) {
    super(
      "chainType",
      pythonChainTypeTyping(mapper, linearizers),
      createPythonChainTypeMemberLookup(cfg.mode, mapper, linearizers),
      { dropOnTypedMiss: true },
    );
  }
}

/**
 * The fold as a typing port. ONE ports object for the life of the resolver —
 * the fold allocates nothing per call site.
 */
function pythonChainTypeTyping(
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): ReceiverTypingPorts {
  const ports = createPythonReceiverTypePorts(mapper, linearizers);
  return {
    typeOfReceiver: (call, ctx) => propagateReceiverType(call.receiver, call.startLine, ctx, ports) ?? null,
  };
}

/**
 * The member walk `chainType` runs on the folded type. Not
 * `createPythonTypeMemberLookup`: that one orders the MRO spellings by the
 * ref's form, while this pass walks in the DEFAULT order and guards the
 * external type between its two walks.
 */
function createPythonChainTypeMemberLookup(
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeMemberLookup {
  return createTypeMemberLookup((type, member, ctx) => {
    // The LAST hop resolves its member through the C3 MRO, exactly as the hops
    // before it read their field and return types (bd tea-rags-mcp-s2w5g).
    // `resolvePythonMemberOnType` below falls back to the single-base
    // `classExtends` chain with an UNFILTERED lookup on each hop, and polar
    // declares `BuildRequestMixin` twice — once in the SDK, once in the
    // generator template it is rendered from — so that lookup is ambiguous and
    // answers `null` on a member jedi pins exactly.
    const linearizer = linearizers?.for(ctx);
    if (linearizer !== undefined) {
      const mro = resolvePythonMemberOnTypeThroughMro(type.name, member, ctx, mode, mapper, linearizer);
      if (mro.target) return mro.target;
    }

    // A folded type whose file is not in the project is external — a miss the
    // pass DROPs rather than hand the call to the short-name passes.
    if (resolveTypeRefFile(type.name, ctx, mapper) === null) return null;

    // The legacy walk stays below the MRO one, not replaced by it: the pass's
    // miss verdict is DROP either way, so keeping it costs no precision and
    // keeps every edge it already answered — including the ones whose type name
    // the MRO walk cannot address at all.
    return resolvePythonMemberOnType(type.name, member, ctx, mode, mapper);
  });
}
