/**
 * Python's ports for the kernel union-receiver cone fan-out (K2, bd
 * tea-rags-mcp-m99j1.1.22) — what `UnionDispatchResolver` asks a language for:
 * the receiver's static type and the population filter.
 *
 * The typing reports a union only where a Python FACT already carries one: a
 * recorded RETURN annotation (`-> A | B`, `Union[A, B]`,
 * `Optional[Union[A, B]]`) or a union-annotated PARAMETER / LOCAL
 * (`x: A | B`, bd tea-rags-mcp-m99j1.1.30), whose binding carries the arms in
 * `typeRef` and no name in `type`. `classFieldTypes` is a bare string map, so a
 * field never hands this port a union — and the port does not widen anything
 * into one. A union reaches a receiver through exactly two folds, asked in the
 * order `localBinding` asks them:
 *
 *   1. the chain fold — `make().run()`, `self.pick().run()`, and a bare name the
 *      walker bound (a union binding's arms placed from the caller's own file,
 *      `pythonPlacedBindingUnion`);
 *   2. the call-result binding — `x = make(); x.run()`, ONE hop, exactly what
 *      `localBinding`'s own typing reads when the walker bound nothing.
 *
 * `Optional[A]` never reaches the kernel as a union: both folds collapse the
 * nil arm through `typeRefReceiverForm`, so a nilable receiver stays with the
 * exact chain and its one edge.
 */
import { nearestCallResultBinding } from "../../../../../contracts/types/codegraph.js";
import { propagateReceiverType, typeRefReceiverForm, type UnionDispatchPorts } from "../../../kernel/index.js";
import { isPythonSourcePath } from "../../vocabulary/source-extensions.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { createPythonCallBindingPorts, createPythonReceiverTypePorts } from "../python-receiver-type-ports.js";
import { pythonCallBindingType } from "../strategies/shared.js";

/**
 * Built ONCE per resolver, like every Python typing port: the fold ports close
 * over the resolver's one mapper and linearizer cache, never over a call site.
 */
export function createPythonUnionDispatchPorts(
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache,
): UnionDispatchPorts {
  const foldPorts = createPythonReceiverTypePorts(mapper, linearizers);
  const bindingPorts = createPythonCallBindingPorts(mapper, linearizers);
  const ports: UnionDispatchPorts = {
    typeOfReceiver: (call, ctx) => {
      const folded = propagateReceiverType(call.receiver, call.startLine, ctx, foldPorts);
      if (folded !== undefined) return folded;
      const bound = nearestCallResultBinding(ctx.callResultBindings, call.receiver, call.startLine);
      if (bound === undefined) return null;
      return typeRefReceiverForm(pythonCallBindingType(bound.callee, bound.line, ctx, bindingPorts, mapper)) ?? null;
    },
    ownsPath: isPythonSourcePath,
  };
  return Object.freeze(ports);
}
