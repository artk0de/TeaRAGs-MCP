/**
 * P6 undecidable — Python's answer to the K11 facade hook `targetsUndecidable`
 * (bd tea-rags-mcp-m99j1.1.24).
 *
 * Python looks an attribute up through the instance, then the class MRO, and
 * only when both miss does it call `__getattr__`; `__getattribute__` replaces
 * the lookup outright. So a member the MRO does not declare, on a class whose
 * MRO defines either hook, is computed at run time — no static reading names
 * the callee, and charging it as a recall hole measures nothing the resolver
 * could ever fix.
 *
 * The verdict is `true` only on proof, because a wrong `true` HIDES a real
 * miss:
 *
 *   - the receiver is TYPED to an INSTANCE — a class-form receiver
 *     (`Cls.member`) is looked up on the metaclass, which an instance
 *     `__getattr__` never sees;
 *   - the type places to a project class, and the member scan over its MRO
 *     finds nothing with the closure `closed` — a branch that leaves the
 *     project may declare the member, so its absence proves nothing;
 *   - a class on that MRO declares `__getattr__` or `__getattribute__` in its
 *     own file.
 *
 * It is asked only for the residual miss (`classifyResolveMiss`), so it moves a
 * row between miss buckets and never touches an edge.
 *
 * A `metaclass=` base is deliberately NOT a hook. Measured on django, the
 * typed misses under a metaclass-built class were a subclass-only method
 * (`self.get_list_display` in `BaseModelAdmin`) and a user model's
 * `natural_key` — real misses, not run-time attributes — so the arm would hide
 * exactly what precision has to keep.
 */
import type { AmbiguousResolveMode, CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import type { ReceiverTypingPorts } from "../../kernel/index.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { parsePythonClassKey, pythonTypeRefClassKey } from "./python-type-addressing.js";
import { resolvePythonInheritedMember } from "./strategies/shared.js";

/** The dunder methods through which a Python class answers attribute lookup itself. */
const PYTHON_ATTRIBUTE_LOOKUP_HOOKS: readonly string[] = ["__getattr__", "__getattribute__"];

/**
 * `typing` is the resolver's one receiver typing — the union component's — so
 * "is this receiver typed" has one answer across the dispatch layer and the
 * miss classifier.
 */
export class PythonUndecidableCallClassifier {
  constructor(
    private readonly typing: ReceiverTypingPorts,
    private readonly mapper: PythonImportFileMapper,
    private readonly linearizers: PythonAncestorLinearizerCache,
    private readonly mode: AmbiguousResolveMode,
  ) {}

  targetsUndecidable(call: CallRef, ctx: CallContext): boolean {
    const { receiver } = call;
    if (receiver === null) return false;
    const type = this.typing.typeOfReceiver({ ...call, receiver }, ctx);
    if (type?.form !== "instance") return false;
    const linearizer = this.linearizers.for(ctx);
    if (linearizer === undefined) return false;
    const classKey = pythonTypeRefClassKey(type.name, ctx, this.mapper);
    if (classKey === null) return false;
    const scan = resolvePythonInheritedMember(classKey, call.member, ctx, this.mode, linearizer);
    if (scan.target !== null || scan.closure !== "closed") return false;
    return linearizer.linearize(classKey).order.some((key) => declaresAttributeLookupHook(key, ctx));
  }
}

/** Does the class `classKey` addresses declare a lookup hook in its own file? */
function declaresAttributeLookupHook(classKey: string, ctx: CallContext): boolean {
  const parsed = parsePythonClassKey(classKey);
  if (parsed === null) return false;
  return PYTHON_ATTRIBUTE_LOOKUP_HOOKS.some((hook) =>
    ctx.symbolTable.lookup(`${parsed.classFq}#${hook}`).some((def) => def.relPath === parsed.relPath),
  );
}
