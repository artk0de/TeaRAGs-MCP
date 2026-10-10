/**
 * A module-scope Python VALUE a receiver denotes (`moduleValueTypes`), the
 * class it holds keyed from the value's own file, and a member on that class.
 * Split out of `strategies/shared.ts` by cohesion cluster (bd
 * tea-rags-mcp-0qaht.43); `shared.ts` re-exports every exported name.
 */

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { AncestorLinearizer, NominalTypeRef } from "../../../kernel/index.js";
import { PYTHON_STDLIB_MODULES } from "../../vocabulary/stdlib-modules.js";
import { pythonModuleValueKey } from "../../walker/passes/python-type-channels.js";
import { parsePythonClassKey, pythonClassKey } from "./python-class-key.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { resolvePythonInheritedMember } from "./python-inherited-member.js";
import {
  findPythonImportBinding,
  lastSegment,
  pythonBoundClassKey,
  pythonDeclaredClassFq,
} from "./python-type-addressing.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

/**
 * A module-scope VALUE a receiver denotes, anchored at the file that binds it
 * (P4, bd tea-rags-mcp-m99j1.1.15): the recorded type, and the KEY of the class
 * that type names, resolved from the VALUE's file rather than the caller's.
 * `apps = Apps(...)` in `django/apps/registry.py` names the `Apps` that file
 * declares, whatever an importing caller happens to call `Apps`.
 */
export interface PythonModuleValueClass {
  readonly type: NominalTypeRef;
  readonly classKey: string;
}

/**
 * `name` as a module-scope value, or `null`. Two ways to reach one:
 *
 *  - an IMPORT bound the name: the import's module maps into the project and
 *    its file — or the one it re-exports from — binds a typed value under it
 *    (`PythonImportFileMapper#resolveExportedValue`). A stdlib import is
 *    refused before the mapper, the rule `importedName` keeps;
 *  - NOTHING bound it locally: no import, and the caller's chunk records no
 *    binding of the name at all — Python makes a name assigned anywhere in a
 *    function local to all of it — so it is the caller's own module global.
 *
 * The class key is the precision gate. The value's own file declaring the class
 * once answers; otherwise exactly one project definition of that short name
 * does. Anything else is a refusal — the declaring file's imports are not
 * reachable from a `CallContext`, so an ambiguous name stays untyped.
 */
export function pythonModuleValueClass(
  name: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): PythonModuleValueClass | null {
  if (ctx.moduleValueTypes === undefined) return null;
  const key = pythonModuleValueKeyFor(name, ctx, mapper);
  return key === null ? null : pythonModuleValueClassAt(key, ctx);
}

/**
 * `name` as a module-scope value of the module FILE `moduleFile` — or of the
 * file it re-exports the name from (`PythonImportFileMapper#resolveExportedValue`)
 * — or `null` (bd tea-rags-mcp-m99j1.1.72). The reading of
 * {@link pythonModuleValueClass} for a value reached through a module ALIAS:
 * `from django.core import signals` then `signals.got_request_exception`, where
 * the caller binds the module rather than the value, so no binding of the
 * value's own name exists to start from. Same fact, same class-key gate.
 */
export function pythonModuleValueClassIn(
  moduleFile: string,
  name: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): PythonModuleValueClass | null {
  if (ctx.moduleValueTypes === undefined) return null;
  const key = mapper.resolveExportedValue(moduleFile, name, ctx);
  return key === null ? null : pythonModuleValueClassAt(key, ctx);
}

/** The class a `moduleValueTypes` entry names, keyed from the VALUE's own file. */
function pythonModuleValueClassAt(key: string, ctx: CallContext): PythonModuleValueClass | null {
  const type = identifierEntry(ctx.moduleValueTypes, key);
  if (type?.form !== "instance") return null;
  const valueFile = key.slice(0, key.lastIndexOf("::"));
  const classKey = pythonValueClassKey(lastSegment(type.name), valueFile, ctx);
  return classKey === null ? null : { type, classKey };
}

/**
 * Does `name` denote a module-scope value the walker typed AT ALL — whatever
 * class it names, project or foreign (bd tea-rags-mcp-m99j1.1.33)? A
 * `contextvars.ContextVar` global answers here while
 * {@link pythonModuleValueClass} refuses it: no project class backs it, yet the
 * value's type is known, so a convention guess about it is not a guess on an
 * untyped name.
 */
export function pythonModuleValueBound(name: string, ctx: CallContext, mapper: PythonImportFileMapper): boolean {
  return ctx.moduleValueTypes !== undefined && pythonModuleValueKeyFor(name, ctx, mapper) !== null;
}

/**
 * Is this an ABSOLUTE import of a stdlib module? Relative text (`.models`) can
 * never name the stdlib and its first segment is empty, so it is excluded
 * rather than tested. (Moved from `python-imported-name.ts`, P4.)
 */
export function pythonImportsStdlibModule(importText: string): boolean {
  if (importText.startsWith(".")) return false;
  return PYTHON_STDLIB_MODULES.has(importText.split(".")[0]);
}

function pythonModuleValueKeyFor(name: string, ctx: CallContext, mapper: PythonImportFileMapper): string | null {
  const binding = findPythonImportBinding(ctx.imports, name);
  if (binding !== null) {
    const { importText } = binding.imp;
    if (pythonImportsStdlibModule(importText)) return null;
    const mapped = mapper.mapImportToFile(importText, ctx.callerFile, ctx);
    return mapped.kind === "project" ? mapper.resolveExportedValue(mapped.relPath, binding.importedName, ctx) : null;
  }
  if (identifierEntry(ctx.localBindings, name) !== undefined) return null;
  if (identifierEntry(ctx.callResultBindings, name) !== undefined) return null;
  const key = pythonModuleValueKey(ctx.callerFile, name);
  return identifierEntry(ctx.moduleValueTypes, key) === undefined ? null : key;
}

function pythonValueClassKey(bareType: string, valueFile: string, ctx: CallContext): string | null {
  const own = pythonBoundClassKey(bareType, valueFile, ctx);
  if (own !== null) return own;
  const defs = lookupPythonSymbolsByShortName(ctx, bareType);
  return defs.length === 1 ? pythonClassKey(defs[0].relPath, pythonDeclaredClassFq(defs[0])) : null;
}

/**
 * `member` on the class a module value holds — instance spelling first, the
 * value is an instance. Up the MRO when the run has a linearizer, else the
 * class's own two spellings in its file; a miss is `null` and the caller keeps
 * its own verdict.
 */
export function resolvePythonModuleValueMember(
  value: PythonModuleValueClass,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  linearizer: AncestorLinearizer<CallContext> | undefined,
): SymbolResolutionTarget | null {
  if (linearizer !== undefined) {
    return resolvePythonInheritedMember(value.classKey, member, ctx, mode, linearizer, {
      spellingOrder: "instanceFirst",
    }).target;
  }
  const parsed = parsePythonClassKey(value.classKey);
  if (parsed === null) return null;
  for (const spelling of [`${parsed.classFq}#${member}`, `${parsed.classFq}.${member}`]) {
    const picked = pickSingleCandidate(
      ctx.symbolTable.lookup(spelling).filter((def) => def.relPath === parsed.relPath),
      mode,
    );
    if (picked) return { targetRelPath: picked.relPath, targetSymbolId: picked.symbolId };
  }
  return null;
}
