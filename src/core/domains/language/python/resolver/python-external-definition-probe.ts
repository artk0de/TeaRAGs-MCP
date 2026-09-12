/**
 * Does an UNRESOLVED Python call need a definition the project does not hold?
 * (bd tea-rags-mcp-1v12o.3)
 *
 * `PythonExternalVocabulary` answers that question from the receiver's TEXT — a
 * dotted receiver rooted at an import that maps outside the project. That reads
 * only the calls a library is NAMED in, and on ugnest it left 225 sites in the
 * `resolveSuccessRate` denominator that the jedi + pyright oracle books as
 * `agreeExt`: `serializer.is_valid()` on a DRF serializer, `self.save()` and
 * `Ticket.objects.create()` on a Django model, `obj.get()` on a `dict`, every
 * `super().m()` whose MRO reaches a library base. The library is nowhere in the
 * receiver text; it is in the receiver's TYPE and in that type's hierarchy.
 *
 * The rule this adds is the one `AncestorClosure` already states: a member is
 * provably ABSENT only under a `closed` hierarchy. So a miss is a recall hole
 * only when the project can prove the definition should have been there —
 *
 *   1. the receiver types to a name NO project file declares (`dict`,
 *      `Response`, `Faker`) — the definition was never ours;
 *   2. the receiver types to a project class, and the member is absent from a
 *      linearization whose closure is `external` — a branch left the project,
 *      so the absence is not evidence;
 *   3. a CHAIN hop is unprovable the same way (`Ticket.objects` — Django
 *      attaches the attribute, and `Ticket`'s MRO leaves the project);
 *   4. `super()` whose linearization past the caller's own class is `external`.
 *
 * An UNTYPED receiver is left exactly where it is. No type, no evidence, no
 * reclassification — precision here runs in REVERSE, since claiming a miss is
 * external HIDES a real recall hole.
 *
 * The probe NEVER emits an edge and is never consulted on a resolved call: its
 * one caller is the vocabulary the runner asks about a miss it has already
 * booked as unresolved.
 */

import {
  nearestCallResultBinding,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { stripCallArgs, type ReceiverTypePorts } from "../../kernel/receiver-type-propagation.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { createPythonReceiverTypePorts } from "./python-receiver-type-ports.js";
import {
  lastSegment,
  lookupPythonSymbolsByShortName,
  pythonAliasedClassKey,
  pythonEnclosingClass,
  resolvePythonInheritedMember,
  resolvePythonMemberOnTypeThroughMro,
} from "./strategies/shared.js";

/** The two spellings the Python walker emits for a zero-argument `super()`. */
const SUPER_RECEIVERS: ReadonlySet<string> = new Set(["super", "super()"]);

/**
 * A single capitalized identifier, one leading underscore allowed — Python's
 * class AND module-constant convention. `_VK_RE = re.compile(...)` is spelled
 * exactly like the private classes this admits, and both are receivers a
 * lowercase local never is.
 */
const PYTHON_CLASS_HEAD = /^_?[A-Z]\w*$/;

/**
 * What the probe could establish about a receiver: a static type, a verdict
 * that it left the project, or nothing at all. `unknown` and `external` are
 * different answers and every caller acts on them differently, which is why
 * `undefined` is not reused for both.
 */
type ReceiverOrigin = { readonly kind: "typed"; readonly type: TypeRef } | { readonly kind: "external" | "unknown" };

const EXTERNAL: ReceiverOrigin = { kind: "external" };
const UNKNOWN: ReceiverOrigin = { kind: "unknown" };

/** Whether the project can say anything about `member` on a known type. */
type AttributeOrigin = "declared" | "external" | "unknown";

/** The two vocabulary answers the probe borrows rather than re-deciding. */
export interface PythonExternalImportPorts {
  /** Is this no-receiver member a builtin, or a name bound from an external module? */
  isBareCallExternal: (member: string, ctx: CallContext) => boolean;
  /** Is this receiver ROOT bound by a non-relative import that maps outside the project? */
  isRootExternalImport: (root: string, ctx: CallContext, atLine?: number) => boolean;
}

export class PythonExternalDefinitionProbe {
  private readonly ports: ReceiverTypePorts;

  constructor(
    private readonly mapper: PythonImportFileMapper,
    private readonly linearizers: PythonAncestorLinearizerCache,
    private readonly mode: AmbiguousResolveMode,
    private readonly imports: PythonExternalImportPorts,
  ) {
    // `classHead` ON, unlike the chain's ports: this probe has no later pass to
    // hand a bare `Cls.member` receiver to, so refusing to type one would make
    // every `Model.objects.…` site unanswerable (bd tea-rags-mcp-z68v9 explains
    // why the RESOLUTION ports keep it off).
    this.ports = createPythonReceiverTypePorts(mapper, linearizers, { classHead: true });
  }

  targetsExternalDefinition(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null) return false;
    if (SUPER_RECEIVERS.has(receiver)) return this.superLeavesProject(call.member, ctx);
    const origin = this.receiverOrigin(receiver, call.startLine, ctx, 0);
    if (origin.kind !== "typed") return origin.kind === "external";
    return this.attributeOrigin(origin.type, call.member, ctx) === "external";
  }

  /**
   * `super().m()` — dispatch starts at the entry AFTER the caller's own class,
   * so the question is whether THAT walk left the project without finding `m`.
   * The super pass itself already DROPs here; this is the same miss, now named.
   */
  private superLeavesProject(member: string, ctx: CallContext): boolean {
    const enclosing = pythonEnclosingClass(ctx);
    const linearizer = this.linearizers.for(ctx);
    if (enclosing === null || linearizer === undefined) return false;
    const scan = resolvePythonInheritedMember(enclosing.key, member, ctx, this.mode, linearizer, { startAfter: true });
    return scan.target === null && scan.closure === "external";
  }

  /**
   * Fold a receiver to its static type, stopping the moment a hop proves the
   * value left the project. Mirrors `propagateChain`'s seed / link walk; it
   * differs only in that a hop it cannot type asks WHY before giving up.
   *
   * `depth` caps the one recursion this has — a receiver bound from a call,
   * whose callee is itself a receiver chain (`row = Ticket.objects.get(...)`).
   */
  private receiverOrigin(receiver: string, atLine: number, ctx: CallContext, depth: number): ReceiverOrigin {
    const hops = (this.ports.splitReceiverHops ?? ((r: string) => r.split(".")))(receiver);
    const head = hops[0];
    if (head === undefined || head.length === 0) return UNKNOWN;
    const seeded = hops.length > 1 ? this.ports.seedHead(head, hops[1], ctx) : undefined;
    let origin: ReceiverOrigin =
      seeded === undefined ? this.headOrigin(head, atLine, ctx, depth) : { kind: "typed", type: seeded.type };
    const links = hops.slice(1 + (seeded?.consumedMembers ?? 0));
    if (links.length > this.ports.maxHops()) return UNKNOWN;
    for (const link of links) {
      if (origin.kind !== "typed") return origin;
      const attribute = stripCallArgs(link);
      const attributeOrigin = this.attributeOrigin(origin.type, attribute, ctx);
      if (attributeOrigin !== "declared") return attributeOrigin === "external" ? EXTERNAL : UNKNOWN;
      const next = this.ports.memberTypeOf(origin.type, attribute, ctx);
      origin = next === undefined ? UNKNOWN : { kind: "typed", type: next };
    }
    return origin;
  }

  /**
   * The chain HEAD, through three channels in precedence order: the type the
   * resolver itself would read, a bare name no project file declares, and the
   * value a recorded assignment call yielded.
   */
  private headOrigin(head: string, atLine: number, ctx: CallContext, depth: number): ReceiverOrigin {
    const typed = head === "cls" ? this.enclosingClassType(ctx) : this.ports.singleHopType(head, atLine, ctx);
    if (typed !== undefined) return { kind: "typed", type: typed };
    if (this.namesNothingInProject(head, ctx)) return EXTERNAL;
    if (this.imports.isRootExternalImport(head, ctx, atLine)) return EXTERNAL;
    if (depth > 0) return UNKNOWN;
    const bound = nearestCallResultBinding(ctx.callResultBindings, head, atLine);
    return bound === undefined ? UNKNOWN : this.calleeResultOrigin(bound.callee, bound.line, ctx, depth + 1);
  }

  /**
   * `cls` is the enclosing class, the way `self` is its instance — the same
   * pairing `isReceiverTyped` already makes. The shared `singleHopType` port
   * answers only `self`, and widening THAT would move the resolver; here it is
   * a boundary question, so `cls.objects.create(...)` gets the same reading
   * `Model.objects.create(...)` gets.
   */
  private enclosingClassType(ctx: CallContext): TypeRef | undefined {
    const enclosing = pythonEnclosingClass(ctx);
    return enclosing === null ? undefined : { form: "class", name: enclosing.name };
  }

  /**
   * A CLASS- or CONSTANT-spelled bare receiver that names no project symbol and
   * no aliased project class: `Faker.seed(...)`, `_VK_RE.match(...)`. The
   * spelling gate is what keeps this off a lowercase local the walker simply
   * failed to bind — that one stays `unknown`.
   */
  private namesNothingInProject(head: string, ctx: CallContext): boolean {
    if (!PYTHON_CLASS_HEAD.test(head)) return false;
    if (lookupPythonSymbolsByShortName(ctx, head).length > 0) return false;
    return pythonAliasedClassKey(head, ctx, this.mapper) === null;
  }

  /**
   * What `x = <callee>(...)` put in `x`. The callee is a receiver chain plus a
   * final member, so it folds through the same walk — `Ticket.objects.get`
   * leaves the project at `objects`, `TicketSelector.get_by_id` yields whatever
   * its recorded return type says, and a bare `authenticate` is decided by the
   * bare-call vocabulary.
   */
  private calleeResultOrigin(callee: string, atLine: number, ctx: CallContext, depth: number): ReceiverOrigin {
    const at = callee.lastIndexOf(".");
    if (at === -1) return this.imports.isBareCallExternal(callee, ctx) ? EXTERNAL : UNKNOWN;
    const origin = this.receiverOrigin(callee.slice(0, at), atLine, ctx, depth);
    if (origin.kind !== "typed") return origin;
    const member = callee.slice(at + 1);
    const attributeOrigin = this.attributeOrigin(origin.type, member, ctx);
    if (attributeOrigin !== "declared") return attributeOrigin === "external" ? EXTERNAL : UNKNOWN;
    const yielded = this.ports.memberTypeOf(origin.type, member, ctx);
    return yielded === undefined ? UNKNOWN : { kind: "typed", type: yielded };
  }

  /**
   * Can the project account for `member` on a receiver of this type?
   *
   * `unbound` from the MRO walk is deliberately NOT read as external — a
   * project class the caller's imports cannot narrow lands there too. The
   * stricter gate is the short-name probe: no python file in the run declares
   * the name at all.
   */
  private attributeOrigin(type: TypeRef, member: string, ctx: CallContext): AttributeOrigin {
    // A `union` / `container` / `nil` receiver names no single class to walk,
    // and `memberTypeOf` already declines them — the same rule, read side.
    if (type.form !== "class" && type.form !== "instance") return "unknown";
    const bare = lastSegment(type.name);
    if (lookupPythonSymbolsByShortName(ctx, bare).length === 0) return "external";
    const linearizer = this.linearizers.for(ctx);
    if (linearizer === undefined) return "unknown";
    const scan = resolvePythonMemberOnTypeThroughMro(bare, member, ctx, this.mode, this.mapper, linearizer);
    if (scan.target !== null) return "declared";
    return scan.closure === "external" ? "external" : "unknown";
  }
}
