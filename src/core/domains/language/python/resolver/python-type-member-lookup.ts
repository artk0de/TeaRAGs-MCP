/**
 * Python's {@link TypeMemberLookup} (bd tea-rags-mcp-m99j1.1.4) — a delegation
 * to the two walks the typed-receiver strategies already run, in the order
 * `PythonChainTypeSymbolResolutionStrategy` runs them:
 *
 *   1. the C3 MRO walk (`resolvePythonMemberOnTypeThroughMro`), when the run has
 *      an ancestor linearizer — the `class` form tries the class spelling
 *      (`Cls.m`) first, the `instance` form the instance spelling (`Cls#m`);
 *   2. otherwise, or on its miss, the type's own file plus its `classExtends`
 *      chain (`resolvePythonMemberOnType`), which still answers the type names
 *      the MRO walk cannot address.
 *
 * The miss VERDICT (DROP, file-only, CONTINUE) stays with each strategy: the
 * port answers "found" or `null`, never a policy.
 */
import type { AmbiguousResolveMode } from "../../../../contracts/types/codegraph.js";
import { createTypeMemberLookup, type TypeMemberLookup } from "../../kernel/index.js";
import type { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { resolvePythonMemberOnType, resolvePythonMemberOnTypeThroughMro } from "./strategies/shared.js";

/**
 * `linearizers` is the run's ancestor-MRO cache, the one the resolver chain
 * shares. Optional, like on the strategies: without it only the `classExtends`
 * walk answers.
 */
export function createPythonTypeMemberLookup(
  mapper: PythonImportFileMapper,
  mode: AmbiguousResolveMode,
  linearizers?: PythonAncestorLinearizerCache,
): TypeMemberLookup {
  return createTypeMemberLookup((type, member, ctx) => {
    const linearizer = linearizers?.for(ctx);
    if (linearizer !== undefined) {
      const mro = resolvePythonMemberOnTypeThroughMro(type.name, member, ctx, mode, mapper, linearizer, {
        spellingOrder: type.form === "class" ? "classFirst" : "instanceFirst",
      });
      if (mro.target) return mro.target;
    }
    return resolvePythonMemberOnType(type.name, member, ctx, mode, mapper);
  });
}
