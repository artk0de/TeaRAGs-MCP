/**
 * Python's known-target callee locator (bd tea-rags-mcp-m99j1.1.42) — where a
 * constructor call the walker spelled from ONE file's syntax really runs.
 *
 * The walker (`walker/passes/python-param-arg-types.ts`) names
 * `<file>::<Name>#__init__` for every file the call's import can denote, and
 * two shapes make that name no indexed def: `from django.http import
 * HttpResponse` reaches a package `__init__.py` that only re-exports the class,
 * and a class with no `__init__` of its own runs an ancestor's. The barrier
 * asks this locator about exactly those candidates, once every file's facts are
 * in.
 *
 * The answer is two class keys. The INSTANCE class is the candidate's class at
 * its declaring address — the re-export followed the way the import mapper
 * follows it for a type (`resolveExportedClassKey`: an alias by its source
 * spelling, stars only when unanimous). The DEFINING class is the first class
 * in the instance class's MRO that declares the member, and only on a CLOSED
 * linearization: a base outside the project, or one the walker could not read,
 * may own the real `__init__`, and a parameter join against a def that never
 * runs would type a field from arguments it never received. Cycles are the
 * kernel linearizer's to guard.
 */
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type KnownTargetCalleeLocator,
} from "../../../../contracts/types/codegraph.js";
import type { KnownTargetCalleeLocatorInput } from "../../../../contracts/types/language.js";
import { findMemberInAncestorChain } from "../../kernel/index.js";
import { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { parsePythonClassKey } from "./python-type-addressing.js";
import { pythonClassKeyIsDeclared } from "./strategies/shared.js";

/** Build one run's locator over the barrier's complete run-global maps. */
export function createPythonKnownTargetCalleeLocator(
  input: KnownTargetCalleeLocatorInput,
  mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE,
): KnownTargetCalleeLocator {
  // The barrier has no caller: the context carries the run-global channels the
  // mapper and the ancestor policy read, and an empty caller they never read.
  const ctx: CallContext = {
    callerFile: "",
    callerScope: [],
    imports: [],
    symbolTable: input.symbolTable,
    moduleReexports: input.moduleReexports,
    classAncestors: input.classAncestors,
  };
  const mapper = new PythonImportFileMapper();
  const linearizer = new PythonAncestorLinearizerCache(mapper, mode).for(ctx);

  const declaresMember = (classKey: string, member: string): boolean => {
    const parsed = parsePythonClassKey(classKey);
    if (parsed === null) return false;
    return ctx.symbolTable.lookup(`${parsed.classFq}#${member}`).some((def) => def.relPath === parsed.relPath);
  };
  const declaringAddress = (classKey: string): string | null => {
    if (pythonClassKeyIsDeclared(classKey, ctx)) return classKey;
    const parsed = parsePythonClassKey(classKey);
    if (parsed === null) return null;
    const reexported = mapper.resolveExportedClassKey(parsed.relPath, parsed.classFq, ctx);
    return reexported !== null && pythonClassKeyIsDeclared(reexported, ctx) ? reexported : null;
  };

  return (coordinate) => {
    const at = coordinate.lastIndexOf("#");
    if (at <= 0) return null;
    const member = coordinate.slice(at + 1);
    const instanceClassKey = declaringAddress(coordinate.slice(0, at));
    if (instanceClassKey === null) return null;
    if (declaresMember(instanceClassKey, member)) return { definingClassKey: instanceClassKey, instanceClassKey };
    if (linearizer === undefined) return null;
    const scan = findMemberInAncestorChain(instanceClassKey, linearizer, (key) =>
      declaresMember(key, member) ? key : null,
    );
    if (scan.closure !== "closed" || scan.definingClassKey === null) return null;
    return { definingClassKey: scan.definingClassKey, instanceClassKey };
  };
}
