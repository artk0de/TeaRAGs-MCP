import {
  isDerivedLocalBinding,
  nearestCallResultBinding,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import {
  LocalBindingSymbolResolutionStrategy,
  typeMemberLookupDefinedFor,
  type NominalTypeRef,
  type ReceiverTypingPorts,
  type TypeMemberLookup,
} from "../../../kernel/index.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { pythonDerivedBindingType, pythonLocalBindingInForce } from "../python-iteration-types.js";
import { createPythonCallBindingPorts } from "../python-receiver-type-ports.js";
import {
  lastSegment,
  pythonCallBindingType,
  resolvePythonMemberOnType,
  resolvePythonMemberOnTypeThroughMro,
  resolveTypeFile,
  type ResolverConfig,
} from "./shared.js";

export { resolveTypeFile } from "./shared.js";

/**
 * Walker-inferred local type — `var.method()` where `var` maps to a known class
 * via `var = ClassName(...)`, `var: ClassName`, or `def f(var: Cls)` in
 * `ctx.localBindings`. Resolution is CONSTRAINED to that class — ordered BEFORE
 * the import-receiver / global short-name passes so an unambiguous local type
 * wins. Mirrors the TS / Go `resolveByLocalType` contract.
 *
 * **A call site answers with a SYMBOL or with nothing** (bd
 * tea-rags-mcp-xasyu). The pass used to resolve the bound type to a FILE and,
 * when the member was not declared on that class, commit a file-only edge to it
 * anyway — the fabrication class AF.6 removed from the short-name path. On the
 * final-chain rows every one of netbox's 223 `localBinding` phantoms is such an
 * edge (`chainTargetSymbolId` null), with 108 further rows carrying the
 * `fileOnly` verdict outright; ugnest reads 56 phantom against 6 match, polar
 * 187 phantom / 42 wrongFile / 103 fileOnly. The import-level FILE edges are
 * `resolveFileEdges`'s to emit and are untouched by this.
 *
 * So the member is looked up ON the bound type through the C3 MRO
 * `resolvePythonInheritedMember` — own class first, then the linearization —
 * the same helper `selfMember` and `importedName` answer with, and the verdict
 * follows the evidence the walk collected rather than the file it started from:
 *
 *   - a defining class in the MRO pins THAT class's spelling (`Cls#m` /
 *     `Cls.m`), so an inherited member names the base, not the bound type;
 *   - a branch that LEFT the project before any definition DROPs. This is where
 *     the `serializer.is_valid()` file-only edge went: DRF's `Serializer` is
 *     the external boundary, and a miss under it is no evidence at all;
 *   - anything the walk could not settle — a base it could not bind, a class
 *     the run does not declare — CONTINUEs to the passes below.
 *
 * **The type's own file is still a terminal guard.** `resolveTypeFile`
 * answering `null` (the type is neither in the symbol table nor reachable via
 * a project import) DROPs, unchanged; so does a file that declares no class
 * under the bound name, because a receiver whose type the project does not
 * declare has no hierarchy to read and handing it to `globalShortName` is the
 * documented false positive (measured: parking this pass wholesale reproduced
 * `serializer.is_valid()` → `ConfirmationCode#is_valid` 68 times with zero
 * same-file upgrades).
 *
 * An index written by walker v2 carries no `classAncestors`, so no linearizer
 * exists for it. That run keeps the pre-seam single-base `classExtends` walk
 * and its flat DROP — minus the file-only edge, which this bead removes on
 * every path.
 *
 * The verdict is the kernel's `LocalBindingSymbolResolutionStrategy` (bd
 * tea-rags-mcp-m99j1.1.5): this class binds {@link pythonLocalBindingTyping} as
 * the typing port and {@link PythonBoundTypeMemberLookup} as the member walk,
 * whose miss — not a flag — decides DROP vs CONTINUE. The walk never returns a
 * file-only target (every arm pins a declared symbol), so the kernel needs no
 * `requirePinnedTarget` to keep bd tea-rags-mcp-xasyu closed.
 */
export class PythonLocalBindingSymbolResolutionStrategy extends LocalBindingSymbolResolutionStrategy {
  constructor(
    cfg: ResolverConfig,
    mapper: PythonImportFileMapper = new PythonImportFileMapper(),
    linearizers?: PythonAncestorLinearizerCache,
  ) {
    const lookup = new PythonBoundTypeMemberLookup(cfg.mode, mapper, linearizers);
    super("localBinding", pythonLocalBindingTyping(mapper, linearizers), lookup, {
      dropOnTypedMiss: (type, call, ctx) => lookup.missDrops(type, call.member, ctx),
    });
  }
}

/**
 * The walker's own binding first, the folded call binding second (bd
 * tea-rags-mcp-z68v9). A `localBindings` entry is a type the walker READ — an
 * annotation, a constructor call, a parameter hint — and a fold is an
 * inference, so the read always wins. The read is a bare type name, carried as
 * an `instance` ref; the member walk below reads only its name.
 *
 * The fold answers only for a `class` / `instance` ref: a container or a
 * union has no single nominal receiver (the kernel CONTINUEs it), and
 * `pythonInheritedMemberType` already declines to emit one.
 *
 * The fold's ports are built ONCE per resolver exactly as `chainType` builds
 * its own.
 */
function pythonLocalBindingTyping(
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): ReceiverTypingPorts {
  const ports = createPythonCallBindingPorts(mapper, linearizers);
  return {
    typeOfReceiver: (call, ctx): TypeRef | null => {
      const binding = pythonLocalBindingInForce(ctx, call.receiver, call.startLine);
      // A derived binding — loop, `with` or unpacking target (bd
      // tea-rags-mcp-m99j1.1.18) — is typed by its fold or not at all: the
      // call-result binding below it predates the statement.
      if (isDerivedLocalBinding(binding)) {
        return pythonDerivedBindingType(binding, ctx, ports, mapper) ?? null;
      }
      const boundType = binding?.type;
      if (boundType) return { form: "instance", name: boundType };
      const bound = nearestCallResultBinding(ctx.callResultBindings, call.receiver, call.startLine);
      if (bound === undefined) return null;
      return pythonCallBindingType(bound.callee, bound.line, ctx, ports, mapper) ?? null;
    },
  };
}

/** Where the member walk on a bound type ended: the target, and the verdict on its miss. */
interface PythonBoundTypeWalk {
  readonly target: SymbolResolutionTarget | null;
  /** `true` = a miss the pass DROPs, `false` = one it hands to the passes below. */
  readonly dropsMiss: boolean;
}

/**
 * The member walk `localBinding` runs on the bound type, and the evidence for
 * its miss verdict. Not `createPythonTypeMemberLookup`: that one orders the MRO
 * spellings by the ref's form, while this pass walks in the DEFAULT order and
 * keeps the walk's closure for the verdict.
 *
 * The kernel asks `findMember` and then, on a miss, the verdict predicate — in
 * one synchronous `attempt`. The last miss is held for that second question so
 * the MRO is walked once per call site; a predicate asked about any other
 * (type, member, context) walks again, which answers the same, because the walk
 * is pure.
 */
class PythonBoundTypeMemberLookup implements TypeMemberLookup {
  private lastMiss:
    | {
        readonly typeName: string;
        readonly member: string;
        readonly ctx: CallContext;
        readonly dropsMiss: boolean;
      }
    | undefined;

  constructor(
    private readonly mode: AmbiguousResolveMode,
    private readonly mapper: PythonImportFileMapper,
    private readonly linearizers: PythonAncestorLinearizerCache | undefined,
  ) {}

  findMember(type: TypeRef, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    if (!typeMemberLookupDefinedFor(type)) return null;
    const walk = this.walk(type.name, member, ctx);
    this.lastMiss = walk.target === null ? { typeName: type.name, member, ctx, dropsMiss: walk.dropsMiss } : undefined;
    return walk.target;
  }

  /** The verdict on a miss of `member` on `type`: `true` DROPs, `false` CONTINUEs. */
  missDrops(type: NominalTypeRef, member: string, ctx: CallContext): boolean {
    const last = this.lastMiss;
    if (last?.typeName === type.name && last.member === member && last.ctx === ctx) return last.dropsMiss;
    return this.walk(type.name, member, ctx).dropsMiss;
  }

  /**
   * `<member>` on the type the walker bound the receiver to.
   *
   *   1. Resolve `typeName` to a FILE — the receiver-matches-import check on
   *      the bare class name (last segment for a qualified `module.ClassName`).
   *      Unknown file ⇒ DROP: the guard that keeps a locally-bound receiver off
   *      the heuristic import / short-name paths.
   *   2. Address the class the run keys it by — dotted FQ inside that file, so
   *      a nested `Outer.Inner` keeps its whole spelling. A file that declares
   *      no such class ⇒ DROP, for the same reason as step 1.
   *   3. Walk the MRO for the member. Found ⇒ the defining class's own symbol;
   *      external boundary ⇒ DROP; `closed` or `unknown` without a definition
   *      ⇒ CONTINUE.
   *
   * Step 1 asks {@link resolveTypeFile} WITHOUT the member on this path, and
   * that is deliberate. The member argument exists to corroborate a bare type
   * name as class-kind before a FILE-only edge is committed to it (bd
   * tea-rags-mcp-lbtmm) — a probe for `<bareType>#<member>` in the table. No
   * file-only edge is committed here any more, and the probe cannot see a
   * nested class at all: `Outer.Inner#run` is spelled by the FQ, never by the
   * bare `Inner`. The MRO IS the class-kind proof that replaces it — a
   * top-level `def` owns no `Cls#m` under any spelling, so the walk finds
   * nothing on it and the site CONTINUEs instead of being attributed. The
   * external-import arm of `resolveTypeFile`, which is what actually killed
   * polar's `def datetime(value)`, runs regardless of the member.
   */
  private walk(typeName: string, member: string, ctx: CallContext): PythonBoundTypeWalk {
    const bareType = lastSegment(typeName);
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) {
      // Walker v2 index — no hierarchy channel to walk, so the bare-name probe
      // is still the only class-kind evidence there is. The single-base
      // `classExtends` fallback (bd tea-rags-mcp-yrs0) is the same one
      // `chainType` folds through, and its miss is terminal here as it always
      // was; only the file-only edge below it is gone.
      if (resolveTypeFile(bareType, ctx, this.mapper, member) === null) return DROPPED_MISS;
      const legacy = resolvePythonMemberOnType(typeName, member, ctx, this.mode, this.mapper);
      return legacy ? { target: legacy, dropsMiss: true } : DROPPED_MISS;
    }

    const { target, closure } = resolvePythonMemberOnTypeThroughMro(
      typeName,
      member,
      ctx,
      this.mode,
      this.mapper,
      linearizer,
    );
    // `unbound` IS steps 1 and 2 above answering `null`, and it keeps their
    // terminal DROP (bd tea-rags-mcp-s2w5g moved the two lookups behind the
    // helper so `selfField` and `chainType` ask them the same way).
    return { target, dropsMiss: closure === "external" || closure === "unbound" };
  }
}

const DROPPED_MISS: PythonBoundTypeWalk = { target: null, dropsMiss: true };
