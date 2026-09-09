/**
 * Shared inputs and helpers for the Python symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `PythonCallResolver(mode)` argument). Python
 * has no tsconfig path mapper, so the config carries only the
 * ambiguous-resolve `mode`.
 *
 * `walkClassExtendsForMethod`, `pythonImportMatchesReceiver`, and `lastSegment`
 * are the helpers shared by more than one strategy AND by the local-type walk —
 * factored here so each lives once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-f10y). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted;
   * env `CODEGRAPH_PY_CONE_MAX` overrides at composition.
   */
  coneMax?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_PY_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * Resolve `<member>` against `startClass` and, on a miss, its IN-PROJECT
 * base-class chain (`classExtends`). bd tea-rags-mcp-yrs0.
 *
 * Walk order: the class itself first (so a method defined on the direct
 * class always wins over an inherited one), then each ancestor reached
 * via single-inheritance `classExtends`, left-to-right MRO-ish. Instance
 * form (`Class#member`) is preferred at each level, static form
 * (`Class.member`) is the fallback.
 *
 * Safety:
 *   - CYCLE GUARD: a `visited` set breaks `A extends B extends A` and
 *     self-references — the walk always terminates.
 *   - IN-PROJECT ONLY: an ancestor whose definition is not in the symbol
 *     table (external base — Django CBVs, werkzeug) yields no lookup hit
 *     and the branch simply continues to its parent (which is usually
 *     undefined for an external base, ending the walk). No edge is
 *     fabricated for an external method.
 *   - DROP on miss: when no class in the chain defines `member`, returns
 *     `null` so the caller does NOT fall through to ambiguous global
 *     short-name resolution.
 */
export function walkClassExtendsForMethod(
  startClass: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const visited = new Set<string>();
  let current: string | undefined = startClass;
  while (current && !visited.has(current)) {
    visited.add(current);
    const instanceHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}#${member}`), mode);
    if (instanceHit) return { targetRelPath: instanceHit.relPath, targetSymbolId: instanceHit.symbolId };
    const staticHit = pickSingleCandidate(ctx.symbolTable.lookup(`${current}.${member}`), mode);
    if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
    current = ctx.classExtends?.[current];
  }
  return null;
}

export function lastSegment(qualified: string): string {
  const parts = qualified.split(".");
  return parts[parts.length - 1] ?? qualified;
}

/**
 * Does this TYPE NAME belong to something outside the project (bd
 * tea-rags-mcp-lbtmm)?
 *
 * Two arms, both positive verdicts rather than residuals:
 *   - a BUILTIN (`dict`, `str`, `list`) — bound by the interpreter, so no
 *     project file can declare it;
 *   - a name an import BOUND from a module the {@link PythonImportFileMapper}
 *     calls `external`. The ROOT segment is what the statement binds, so
 *     `io.BytesIO` is decided by `io` and `Pattern` by itself.
 *
 * Same shape — deliberately — as `PythonExternalVocabulary.isBareCallExternal`:
 * the vocabulary and the chain must answer one import question the same way, or
 * a call the chain drops lands back in the recall denominator.
 *
 * `false` means UNKNOWN, never "in project": nothing here proves a type is
 * ours, and the callers act on the two verdicts differently.
 */
export function pythonTypeNameIsExternal(typeName: string, ctx: CallContext, mapper: PythonImportFileMapper): boolean {
  const root = typeName.split(".")[0];
  if (root.length === 0) return false;
  if (PYTHON_BUILTINS.has(root)) return true;
  for (const imp of ctx.imports) {
    const bound = imp.importedBindings?.[root] ?? (imp.importedNames?.includes(root) ? root : undefined);
    if (bound === undefined) continue;
    if (mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx).kind === "external") return true;
  }
  return false;
}

/**
 * Can `bareType` OWN a member — is it class-kind (bd tea-rags-mcp-lbtmm)?
 *
 * A Python `class Foo` and a top-level `def foo` are INDISTINGUISHABLE in the
 * symbol table: both compose a bare `symbolId` with an empty scope, and
 * `SymbolDefinition` carries no kind. So the question is answered by
 * corroboration instead, and any ONE channel is enough:
 *
 *   - the walker recorded a BASE class for it (`classExtends`) — the shape
 *     behind every legitimate file-only edge, since a member the class itself
 *     does not declare has to be inherited from somewhere;
 *   - the walker recorded typed FIELDS on it (`classFieldTypes`);
 *   - the table holds `<Type>#<member>` / `<Type>.<member>` — it owns the very
 *     member under resolution.
 *
 * No member to probe (the cone locator asks about a type, not a call) leaves
 * the first two channels, so the answer degrades toward "yes" rather than
 * silently narrowing a caller that never asked for the guard.
 *
 * The measured miss this refuses: polar declares `def datetime(value)` in
 * `server/polar/backoffice/formatters.py`, and it was the sole short-name match
 * for every `x: datetime` receiver in the repo.
 */
export function pythonTypeOwnsMembers(bareType: string, member: string | undefined, ctx: CallContext): boolean {
  if (ctx.classExtends?.[bareType] !== undefined) return true;
  if (ctx.classFieldTypes?.[bareType] !== undefined) return true;
  if (member === undefined) return true;
  return (
    ctx.symbolTable.lookup(`${bareType}#${member}`).length > 0 ||
    ctx.symbolTable.lookup(`${bareType}.${member}`).length > 0
  );
}

export function pythonImportMatchesReceiver(importText: string, receiver: string): boolean {
  // Strip leading dots (relative-import marker) for the comparison —
  // `..foo.bar` should still match `bar` as a receiver. Compare
  // case-sensitively: Python is case-sensitive (User != user).
  const cleaned = importText.replace(/^\.+/, "");
  const segments = cleaned.split(".").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}
