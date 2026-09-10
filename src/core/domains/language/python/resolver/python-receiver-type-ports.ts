/**
 * Python's four answers for the shared chain fold
 * (`kernel/receiver-type-propagation.ts`, E1 seam 3, bd tea-rags-mcp-9fgdi).
 *
 * The channels are the ones Python already carries: `localBindings` for a
 * variable, `classFieldTypes` for `self.<attr>`, and `structuredReturnTypes`
 * for what a call yields — the last of which the annotation facet fills and
 * nothing read until this seam.
 *
 * The ports are built ONCE per resolver, not per call site: `ctx` is an
 * argument to every one of them, and the only thing the factory closes over is
 * the `PythonImportFileMapper` whose memo is keyed by symbol-table identity.
 * That mapper is why this is a factory rather than the frozen module-level
 * singleton the plan sketched — `resolveTypeFile` needs one, the resolver owns
 * exactly one so every consumer shares its resolved-root cache, and a private
 * one per module would both fragment the cache and diverge from what
 * `localBinding` / `importedName` ask the same question with.
 * Allocation stays at one object per resolver, which is what the perf budget
 * (`wall ≤ +25%` on netbox) actually cares about.
 */

import { resolveLocalBinding, type CallContext, type LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  findPythonImportBinding,
  pythonImportMatchesReceiver,
  pythonInheritedMemberType,
  resolveTypeFile,
} from "./strategies/shared.js";

export const PYTHON_CHAIN_MAX_HOPS_ENV = "CODEGRAPH_PY_CHAIN_MAX_HOPS";

/** A single capitalized identifier — Python's class-name convention, no `::`. */
const PYTHON_CLASS_HEAD = /^[A-Z]\w*$/;

/** Read the cap per call so a test env override needs no module reload. */
function pythonMaxHops(): number {
  const raw = process.env[PYTHON_CHAIN_MAX_HOPS_ENV];
  if (raw === undefined) return CHAIN_MAX_HOPS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHAIN_MAX_HOPS_DEFAULT;
}

/**
 * `self` is the enclosing class as an INSTANCE; `Cls(…)` is a constructor call
 * and therefore also an instance; a bare name is a local variable. Nothing
 * else — an unbound bare name in Python is a `NameError`, not a self-call, so
 * Ruby's `nullaryReceiverType` has no analogue here.
 *
 * The local-variable branch is only ever reached as a chain HEAD: `localBinding`
 * runs before `chainType` and is terminal (resolved or DROP) for a bare bound
 * receiver, so a single-segment receiver never gets here.
 */
function pythonSingleHopType(
  receiver: string,
  atLine: number,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  classHead: boolean,
): TypeRef | undefined {
  if (receiver === "self") {
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    return enclosing === undefined ? undefined : { form: "instance", name: enclosing };
  }
  if (receiver.endsWith(")")) {
    const bare = stripCallArgs(receiver);
    if (!PYTHON_CLASS_HEAD.test(bare) || resolveTypeFile(bare, ctx, mapper) === null) return undefined;
    return { form: "instance", name: bare };
  }
  const bound = pythonBindingInForceAt(receiver, atLine, ctx);
  if (bound !== undefined) return { form: "instance", name: bound.type };
  // A bare class name in receiver position: `Repo.from_session(…)` — CLASS
  // form, so `memberTypeOf` reads the `Cls.member` spelling a `@classmethod`
  // produces. Gated on the class resolving to a PROJECT file: `os.Path` in a
  // project that never imports `os` is not evidence, it is a coincidence of
  // capitalisation.
  if (!classHead) return undefined;
  return PYTHON_CLASS_HEAD.test(receiver) && resolveTypeFile(receiver, ctx, mapper) !== null
    ? { form: "class", name: receiver }
    : undefined;
}

/**
 * The binding a receiver actually carries at `atLine` — which is NOT always the
 * one `resolveLocalBinding` returns (R4c, bd tea-rags-mcp-jeqyg).
 *
 * `layout = layout.SimpleLayout(...)` in eleven netbox view files: the walker
 * records `layout -> SimpleLayout` at that line, and the fold then types the
 * RECEIVER of the very call that produced it. Python evaluates the right-hand
 * side before it rebinds the name, so on that statement `layout` still denotes
 * what `from netbox.ui import layout` bound — a MODULE. Typing it as the class
 * being constructed makes `chainType` look for `SimpleLayout` ON `SimpleLayout`,
 * find nothing, and DROP, which cuts off the module arm of `importedName` that
 * answers the site correctly. 165 rows.
 *
 * The narrow gate is the import list: the shadow only exists where an import
 * bound the same name, and there the prior binding is the import rather than
 * anything the walker recorded. Without that clause the rule would also demote
 * `x = Foo(); x.run()` on one line, which no evidence asks for. `line <= atLine`
 * in the shared lookup stays exactly as it is — the retry simply asks it for the
 * line before, so a name bound EARLIER in the body keeps that earlier type.
 *
 * The window is the STATEMENT, not its first line (bd tea-rags-mcp-w205u,
 * E4.6a). netbox's `layout = layout.Layout(\n    layout.Row(…))` puts the inner
 * receivers on lines 205, 206, 212 against a binding at 204, and a same-line
 * test sees none of them — 50 more rows of the identical shape. `endLine` is
 * the extent the walker records; ABSENT it degenerates to the same-line test it
 * replaces, so an index written by an earlier walker behaves exactly as before.
 *
 * The retry asks for `bound.line - 1` rather than `atLine - 1`: at line 210
 * against a binding at 204, the line before the CALL still finds the very
 * binding being demoted.
 */
function pythonBindingInForceAt(receiver: string, atLine: number, ctx: CallContext): LocalBinding | undefined {
  const bound = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  if (bound === undefined || atLine > (bound.endLine ?? bound.line)) return bound;
  if (findPythonImportBinding(ctx.imports, receiver) === null) return bound;
  return resolveLocalBinding(ctx.localBindings, receiver, bound.line - 1);
}

/**
 * A head that is a module alias rather than a value: `mod.Cls()`.
 *
 * The link arrives RAW so the parens are still visible, and they decide the
 * form: `mod.Cls().run()` dispatches an INSTANCE method, `mod.Cls.run()` a
 * static one. Collapsing both to one form would send half these sites to the
 * wrong symbolId, which is the failure mode this program is gated against.
 *
 * The head must actually be imported and the class must actually be defined in
 * the file that import maps to. A capitalized first link alone is not
 * evidence — `os.Path` in a project that never imports `os` is nothing.
 */
function pythonSeedHead(
  head: string,
  firstLink: string | undefined,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 0 | 1 } | undefined {
  if (firstLink === undefined) return undefined;
  const alias = pythonModuleAliasSeed(head, firstLink, ctx, mapper);
  return alias ?? pythonClassChainHeadSeed(head, ctx, mapper);
}

/** `mod.Cls()` / `mod.Cls` — the module-alias arm of {@link pythonSeedHead}. */
function pythonModuleAliasSeed(
  head: string,
  firstLink: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 1 } | undefined {
  const member = stripCallArgs(firstLink);
  if (!PYTHON_CLASS_HEAD.test(member)) return undefined;
  const imported = ctx.imports.some((imp) => pythonImportMatchesReceiver(imp.importText, head));
  if (!imported || resolveTypeFile(member, ctx, mapper) === null) return undefined;
  const form = firstLink.endsWith(")") ? "instance" : "class";
  return { type: { form, name: member }, consumedMembers: 1 };
}

/**
 * A bare CLASS name as a CHAIN head: `ObjectType.objects.get_for_model(m)` (bd
 * tea-rags-mcp-xpl83).
 *
 * The class-body field facts type `<Model>.objects`, and this is what lets the
 * fold reach them. It is deliberately the chain-head half of `singleHopType`'s
 * `classHead` arm and not that arm itself: `seedHead` is reached ONLY from
 * `propagateChain`, so a single-segment `Cls.member()` receiver never sees it and
 * keeps going to `importedName` exactly as it does today — which is what the
 * `classHead` default protects.
 *
 * Seeding is inert by construction. `consumedMembers: 0` hands the first link
 * straight to `memberTypeOf`, and stop-at-unknown-hop unwinds the whole receiver
 * to untyped unless that link has a real field or return fact. A class with no
 * `objects` attribute folds to nothing and the call reaches the same strategy it
 * reaches today.
 *
 * A local binding on the same name WINS: `singleHopType` would have typed the
 * head from it, and a name Python rebound is a value rather than the class.
 */
function pythonClassChainHeadSeed(
  head: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): { type: TypeRef; consumedMembers: 0 } | undefined {
  if (!PYTHON_CLASS_HEAD.test(head)) return undefined;
  if (ctx.localBindings?.[head] !== undefined) return undefined;
  if (resolveTypeFile(head, ctx, mapper) === null) return undefined;
  return { type: { form: "class", name: head }, consumedMembers: 0 };
}

/**
 * What calling / accessing `member` on a receiver of type `recv` yields.
 *
 * Two channels, attribute first:
 *  1. `classFieldTypes[<class>][member]` — `self.repo` inside `Svc` is a
 *     `Repo`, written by the walker's `__init__` inference and by the
 *     annotation facet's `ivar` facts.
 *  2. `structuredReturnTypes[<symbolId>]` — what `member` RETURNS, keyed by the
 *     callee's own symbolId: `Cls#member` on an instance receiver,
 *     `Cls.member` on a class receiver. Nested owners already arrive joined
 *     with `.` (`python/kernel.ts:41`), so never re-compose the key.
 *
 * An attribute and a method can share a name; the attribute is the narrower
 * statement (it names the class that owns it) and `classFieldTypes` only holds
 * constructor-assigned or annotated fields, so it is the safer first read.
 *
 * A `container` or `union` receiver yields nothing: Python's `list[Foo]` types
 * the LIST, not an element, so unwrapping it the way Ruby unwraps a YARD
 * `Array<Post>` would resolve `xs.append` against `Foo`. The annotation facet
 * already declines to emit those as bindings (its decision 4); this is the same
 * rule stated on the read side.
 *
 * Both channels are read UP THE MRO, not just on the class the receiver names
 * (bd tea-rags-mcp-yl85b) — see `pythonInheritedMemberType`. This is the one
 * place either channel is consulted, so the walk lives there and not in each
 * strategy.
 */
function pythonMemberTypeOf(
  recv: TypeRef,
  member: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache | undefined,
): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  return pythonInheritedMemberType(recv.name, member, recv.form, ctx, mapper, linearizers?.for(ctx));
}

/**
 * Python's `ReceiverTypePorts`, bound to the resolver's own import mapper.
 * Call it ONCE per resolver and hand the result to `propagateReceiverType`.
 *
 * `linearizers` is the run's ancestor-MRO cache, threaded exactly as the mapper
 * is (bd tea-rags-mcp-yl85b). It stays OPTIONAL so every existing construction
 * site compiles untouched and keeps the own-class-only read; the cache itself
 * answers `undefined` on an index carrying no `classAncestors`, so the pre-seam
 * behaviour is a property of the CONTEXT rather than of the caller.
 *
 * `options.classHead` opts into the bare-class receiver arm and defaults OFF
 * (bd tea-rags-mcp-z68v9). `Repo.member()` reaching `chainType` with that arm
 * on would be answered THERE, one pass earlier than `importedName` and through
 * the weaker legacy `classExtends` walk rather than the MRO — a strict
 * downgrade on a receiver kind already sitting at 1,297/1,309 on polar. The arm
 * therefore belongs to the one consumer with no other way to type a callee's
 * receiver; see {@link createPythonCallBindingPorts}.
 */
export function createPythonReceiverTypePorts(
  mapper: PythonImportFileMapper,
  linearizers?: PythonAncestorLinearizerCache,
  options: { readonly classHead?: boolean } = {},
): ReceiverTypePorts {
  const classHead = options.classHead ?? false;
  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      pythonSingleHopType(receiver, atLine, ctx, mapper, classHead),
    seedHead: (
      head: string,
      firstLink: string | undefined,
      ctx: CallContext,
    ): { type: TypeRef; consumedMembers: 0 | 1 } | undefined => pythonSeedHead(head, firstLink, ctx, mapper),
    memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined =>
      pythonMemberTypeOf(recv, member, ctx, mapper, linearizers),
    maxHops: pythonMaxHops,
  });
}

/**
 * The ports the call-binding fold uses — {@link createPythonReceiverTypePorts}
 * plus the bare-class receiver arm (bd tea-rags-mcp-z68v9).
 *
 * `repository = SubscriptionRepository.from_session(session)` is 338 of polar's
 * 470 `localVar` misses, and its callee's receiver is a bare CLASS name. No
 * other consumer needs that arm — every other receiver a chain folds is a
 * `self`, a constructor call or a local — and turning it on globally would move
 * `Cls.member()` sites off `importedName`. One extra frozen object per
 * resolver buys that separation.
 */
export function createPythonCallBindingPorts(
  mapper: PythonImportFileMapper,
  linearizers?: PythonAncestorLinearizerCache,
): ReceiverTypePorts {
  return createPythonReceiverTypePorts(mapper, linearizers, { classHead: true });
}
