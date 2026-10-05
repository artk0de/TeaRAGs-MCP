/**
 * The ONE composition of Python's dispatch fan-out components, shared by
 * `PythonCallResolver` and the offline jedi oracle's parity stack. The oracle
 * used to hand-copy this list and silently lost the union component when it
 * landed (`dispatchDrift` fired on every union fan, every fan number void) —
 * there is nothing left to keep in sync.
 */
import type { AmbiguousResolveMode } from "../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../contracts/types/language.js";
import { ConeDispatchResolver, UnionDispatchResolver, type ExternalCallClassifier } from "../../kernel/index.js";
import {
  PythonCallableParamDispatchResolver,
  pythonDynamicDispatchEnabled,
  PythonDynamicDispatchResolver,
  PythonTableDispatchResolver,
  type PythonChainAnswerProbe,
} from "./dispatch/index.js";
import type { createPythonUnionDispatchPorts } from "./dispatch/python-union-ports.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { PythonCallableParamTargets } from "./python-callable-param-targets.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { createPythonTypeMemberLookup } from "./python-type-member-lookup.js";
import { PythonConeTypeLocator, type ResolverConfig } from "./strategies/index.js";

export interface PythonDispatchComponentDeps {
  cfg: ResolverConfig;
  coneMax: number;
  mode: AmbiguousResolveMode;
  mapper: PythonImportFileMapper;
  linearizers: PythonAncestorLinearizerCache;
  unionPorts: ReturnType<typeof createPythonUnionDispatchPorts>;
  /** The chain's per-site answer — the table's and (when composed) dynamic's gate. */
  probe: PythonChainAnswerProbe;
  external: ExternalCallClassifier;
}

/**
 * Components in PRECEDENCE order, first non-empty wins: table, callableParam,
 * union, cone, then `dynamic` only under `CODEGRAPH_PY_DYNAMIC_DISPATCH` (off by
 * default, D10). Rationale per component is on `PythonCallResolver`.
 */
export function createPythonDispatchComponents(deps: PythonDispatchComponentDeps): DispatchResolverComponent[] {
  const { cfg, coneMax, mode, mapper, linearizers, unionPorts, probe, external } = deps;
  const components: DispatchResolverComponent[] = [
    new PythonTableDispatchResolver((call, ctx) => probe.resolve(call, ctx), mapper),
    new PythonCallableParamDispatchResolver(new PythonCallableParamTargets(mapper)),
    new UnionDispatchResolver(unionPorts, createPythonTypeMemberLookup(mapper, mode, linearizers), coneMax),
    new ConeDispatchResolver(new PythonConeTypeLocator(cfg, mapper), coneMax),
  ];
  if (pythonDynamicDispatchEnabled(process.env.CODEGRAPH_PY_DYNAMIC_DISPATCH)) {
    components.push(
      new PythonDynamicDispatchResolver(
        probe,
        (call, ctx) => external.targetsCoreAmbiguousMember(call, ctx),
        mapper,
        undefined,
        cfg.assignedLocalGate,
      ),
    );
  }
  return components;
}
