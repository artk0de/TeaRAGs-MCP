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

import { resolveLocalBinding, type CallContext } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  CHAIN_MAX_HOPS_DEFAULT,
  stripCallArgs,
  type ReceiverTypePorts,
} from "../../kernel/receiver-type-propagation.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { pythonImportMatchesReceiver, resolveTypeFile } from "./strategies/shared.js";

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
  const bound = resolveLocalBinding(ctx.localBindings, receiver, atLine);
  return bound === undefined ? undefined : { form: "instance", name: bound.type };
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
  const member = stripCallArgs(firstLink);
  if (!PYTHON_CLASS_HEAD.test(member)) return undefined;
  const imported = ctx.imports.some((imp) => pythonImportMatchesReceiver(imp.importText, head));
  if (!imported || resolveTypeFile(member, ctx, mapper) === null) return undefined;
  const form = firstLink.endsWith(")") ? "instance" : "class";
  return { type: { form, name: member }, consumedMembers: 1 };
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
 */
function pythonMemberTypeOf(recv: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
  if (recv.form !== "class" && recv.form !== "instance") return undefined;
  const fieldType = ctx.classFieldTypes?.[recv.name]?.[member];
  if (fieldType !== undefined) return { form: "instance", name: fieldType };
  const separator = recv.form === "class" ? "." : "#";
  return ctx.structuredReturnTypes?.[`${recv.name}${separator}${member}`];
}

/**
 * Python's `ReceiverTypePorts`, bound to the resolver's own import mapper.
 * Call it ONCE per resolver and hand the result to `propagateReceiverType`.
 */
export function createPythonReceiverTypePorts(mapper: PythonImportFileMapper): ReceiverTypePorts {
  return Object.freeze({
    singleHopType: (receiver: string, atLine: number, ctx: CallContext): TypeRef | undefined =>
      pythonSingleHopType(receiver, atLine, ctx, mapper),
    seedHead: (
      head: string,
      firstLink: string | undefined,
      ctx: CallContext,
    ): { type: TypeRef; consumedMembers: 0 | 1 } | undefined => pythonSeedHead(head, firstLink, ctx, mapper),
    memberTypeOf: pythonMemberTypeOf,
    maxHops: pythonMaxHops,
  });
}
