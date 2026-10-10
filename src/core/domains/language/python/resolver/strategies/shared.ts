/**
 * Shared inputs and helpers for the Python symbol-resolution strategies — a
 * re-export barrel, so `strategies/shared.js` stays the one import path the
 * strategies, tests and scripts use. It DEFINES nothing; every name lives in a
 * leaf beside it, and no leaf imports this file back (the vertical's import
 * graph is acyclic, `python-resolver-import-graph.test.ts`).
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `PythonCallResolver(mode)` argument). Python
 * has no tsconfig path mapper, so the config carries only the
 * ambiguous-resolve `mode`.
 *
 * The helpers shared by more than one strategy AND by the local-type walk were
 * factored here so each lives once, then split by cohesion cluster (bd
 * tea-rags-mcp-0qaht.43): the receiver-origin helpers to
 * `python-receiver-binding.ts`, the inherited-member walks to
 * `python-inherited-member.ts`, the module-value reads to
 * `python-module-value-class.ts`.
 */

/**
 * Moved out of this hub to resolver-root leaves (bd tea-rags-mcp-m99j1.1.29) and
 * re-exported, so `strategies/shared.js` stays the one import path the
 * strategies, tests and scripts use: the class/import ADDRESSING helpers to
 * `../python-type-addressing.js`, the member-return-type walk to
 * `../python-member-return-types.js`.
 */
export {
  findPythonImportBinding,
  lastSegment,
  parsePythonClassKey,
  pythonAliasedClassKey,
  pythonBoundClassKey,
  pythonClassKey,
  pythonClassKeyIsDeclared,
  pythonDeclaredClassFq,
  pythonImportBoundFile,
  pythonTypeNameIsExternal,
  pythonTypeOwnsMembers,
  resolveTypeFile,
  resolveTypeRefFile,
  type PythonImportBinding,
} from "./python-type-addressing.js";
export {
  pythonBareCallReturnType,
  pythonCallBindingType,
  pythonInheritedAttributeType,
  pythonInheritedMemberType,
  pythonModuleReturnType,
  pythonSubstituteSelfReturn,
  type PythonMemberAccess,
} from "./python-member-return-types.js";

/**
 * The language-filtered short-name lookup, re-exported so
 * `strategies/shared.js` stays the one import path the strategies use. It is
 * DEFINED one level up, in the leaf `../short-name-lookup.js`, so the
 * resolver-root modules the strategies reach back into — the
 * `PythonImportFileMapper` type foremost — can use it without closing an
 * import cycle (bd tea-rags-mcp-0qaht.35); see there.
 */
export { lookupPythonSymbols, lookupPythonSymbolsByShortName, PYTHON_SYMBOL_KIND_ROLES } from "./short-name-lookup.js";

/**
 * `ResolverConfig` / `CONE_MAX_DEFAULT` live in the kernel
 * (`readResolverConfig` builds the config); re-exported so
 * `strategies/shared.js` stays the one import path the strategies use.
 * `CODEGRAPH_PY_CONE_MAX` overrides at composition.
 */
export { CONE_MAX_DEFAULT, type ResolverConfig } from "../../../kernel/index.js";

export {
  pythonBoundToForeignCall,
  pythonEnclosingClass,
  pythonImportMatchesReceiver,
  receiverModuleText,
  type PythonEnclosingClass,
} from "./python-receiver-binding.js";
export {
  resolvePythonInheritedMember,
  resolvePythonMemberOnType,
  resolvePythonMemberOnTypeThroughMro,
  walkClassExtendsForMethod,
  type PythonInheritedMemberResult,
  type PythonTypeMemberClosure,
  type PythonTypeMemberResolution,
} from "./python-inherited-member.js";
export {
  pythonImportsStdlibModule,
  pythonModuleValueBound,
  pythonModuleValueClass,
  pythonModuleValueClassIn,
  resolvePythonModuleValueMember,
  type PythonModuleValueClass,
} from "./python-module-value-class.js";
