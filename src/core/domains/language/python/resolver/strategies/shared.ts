/**
 * Shared inputs and helpers for the Python symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `PythonCallResolver(mode)` argument). Python
 * has no tsconfig path mapper, so the config carries only the
 * ambiguous-resolve `mode`.
 *
 * `walkClassExtendsForMethod`, `pythonImportMatchesReceiver`, `lastSegment`,
 * `findPythonImportBinding`, `resolveTypeFile` and `resolvePythonMemberOnType`
 * are the helpers shared by more than one strategy AND by the local-type walk
 * — factored here so each lives once.
 */

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type ImportRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import { PYTHON_BUILTINS } from "../../vocabulary/builtins.js";
import type { PythonImportFileMapper } from "../python-import-file-mapper.js";
import { mapPythonImportToFile } from "../python-path-mapper.js";

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

/** One import statement, the local name it bound, and the name the module exports. */
export interface PythonImportBinding {
  imp: ImportRef;
  localName: string;
  importedName: string;
}

/**
 * The import that bound `localName`, with the name the MODULE exports it under.
 *
 * `importedBindings` is the authority (it survives aliasing);
 * `importedNames` alone means the statement bound the name unaliased, which is
 * the shape `from a import b` produces when a walker-1 file is mixed in.
 */
export function findPythonImportBinding(imports: readonly ImportRef[], localName: string): PythonImportBinding | null {
  for (const imp of imports) {
    const importedName = imp.importedBindings?.[localName];
    if (importedName) return { imp, localName, importedName };
  }
  for (const imp of imports) {
    if (imp.importedBindings) continue; // already consulted above; do not re-answer
    if (imp.importedNames?.includes(localName)) return { imp, localName, importedName: localName };
  }
  return null;
}

/**
 * Find the file path of a bare class name by walking the import list.
 * Two shapes match:
 *   - `from <module> import <Bare>` — importText is `<module>`; the
 *     class name appears in the symbol table at the file `<module>`
 *     resolves to.
 *   - `import <module>` where `<module>` ends in the bare type name.
 *
 * Returns the file path of the class definition when an import
 * resolves there, or `null` otherwise.
 *
 * Both import-consulting passes go through `PythonImportFileMapper` (bd
 * tea-rags-mcp-9fgdi): membership in the symbol table, never a path synthesised
 * from the module text. An `external` verdict contributes NOTHING — attributing
 * a type to `rest_framework/serializers.py` is the phantom this seam removes.
 * An `unknown` verdict keeps the pre-seam fallback, per decision 1 of
 * `docs/superpowers/plans/2026-09-08-python-import-file-mapper.md`: three
 * states exist precisely so "I cannot tell" and "I know it is a library" behave
 * differently.
 *
 * `member` is the member being resolved ON the type, and it is what lets the
 * short-name pass tell a class from a same-named `def` (bd tea-rags-mcp-lbtmm)
 * — see {@link pythonTypeOwnsMembers}. Optional: the cone locator asks about a
 * TYPE with no call in hand, and omitting it leaves that caller's answers
 * exactly as they were.
 */
export function resolveTypeFile(
  bareType: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
  member?: string,
): string | null {
  // An import-bound name the mapper calls EXTERNAL is a library class, and no
  // project file declares it. Deciding that FIRST is what stops the short-name
  // pass below from answering with a namesake: `from datetime import datetime`
  // in 53 polar files, against polar's own `def datetime(value)` in
  // `server/polar/backoffice/formatters.py` (bd tea-rags-mcp-lbtmm).
  if (pythonTypeNameIsExternal(bareType, ctx, mapper)) return null;

  // First pass: scan symbol table for ANY definition matching the
  // bare type name. If it's unique we have the file directly — provided the
  // match can OWN a member at all, which a top-level `def` cannot.
  const tableMatches = ctx.symbolTable.lookupByShortName(bareType);
  if (tableMatches.length === 1) {
    return pythonTypeOwnsMembers(bareType, member, ctx) ? tableMatches[0].relPath : null;
  }

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports. Only a
  // `project` verdict names a file the table can hold, so it is the only one
  // that can narrow the candidates.
  if (tableMatches.length > 1) {
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind === "project") importedFiles.add(mapped.relPath);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // Still ambiguous — refuse to guess.
    return null;
  }

  // Third pass: bare type not in symbol table (defined outside the
  // project — e.g. DRF Serializer). Walk imports: if any import path
  // ends in the type name and maps to a file, attribute to that.
  for (const imp of ctx.imports) {
    if (lastSegment(imp.importText) !== bareType) continue;
    const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
    if (mapped.kind === "project") return mapped.relPath;
    if (mapped.kind === "external") continue;
    const file = mapPythonImportToFile(imp.importText, ctx.callerFile);
    if (file) return file;
  }
  return null;
}

/**
 * Resolve `<typeName>.<member>` inside the file that defines `typeName`, then
 * up its IN-PROJECT `classExtends` chain. `null` when no class in the chain
 * defines the member — the CALLER decides whether that is a file-only edge
 * (a direct local binding, bd tea-rags-mcp-yrs0 / 86qfb) or a DROP (a folded
 * chain type, which has no measurement supporting the weaker answer).
 */
export function resolvePythonMemberOnType(
  typeName: string,
  member: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
  mapper: PythonImportFileMapper,
): SymbolResolutionTarget | null {
  const bareType = lastSegment(typeName);
  const targetFile = resolveTypeFile(bareType, ctx, mapper, member);
  if (!targetFile) return null;
  const candidates = ctx.symbolTable
    .lookupByShortName(member)
    .filter((def) => def.relPath === targetFile && def.scope[def.scope.length - 1] === bareType);
  const target = pickSingleCandidate(candidates, mode);
  if (target) return { targetRelPath: target.relPath, targetSymbolId: target.symbolId };
  // bd tea-rags-mcp-yrs0 — `member` is not defined on the type itself. Walk its
  // IN-PROJECT base chain before giving up: an inherited `Leaf().shared()`
  // where `shared` lives on `Base` resolves to `Base#shared`. The walk starts
  // one level up (the type was already checked above).
  const parent = ctx.classExtends?.[bareType];
  return parent ? walkClassExtendsForMethod(parent, member, ctx, mode) : null;
}
