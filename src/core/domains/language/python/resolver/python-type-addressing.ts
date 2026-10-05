/**
 * Python type and class ADDRESSING — the helpers that turn a type name, an
 * import binding and a symbol-table definition into a file or a run-global class
 * key (`<relPath>::<dotted class FQ>`).
 *
 * A resolver-root leaf by construction (bd tea-rags-mcp-m99j1.1.29): it imports
 * the codegraph contracts, the leaf `short-name-lookup.js`, the builtin
 * vocabulary and the path mapper — never `strategies/shared.ts`. The
 * member-return-type walk (`python-member-return-types.ts`) needs these and
 * lives beside this file, so defining them in the strategies hub would close an
 * import cycle. `strategies/shared.ts` re-exports every name, so existing import
 * paths keep working (same pattern as `short-name-lookup.ts`).
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { CallContext, ImportRef } from "../../../../contracts/types/codegraph.js";
import { PYTHON_BUILTINS } from "../vocabulary/builtins.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { mapPythonImportToFile } from "./python-path-mapper.js";
import { lookupPythonSymbolsByShortName } from "./short-name-lookup.js";

/**
 * The run-global address of a Python class: `<relPath>::<dotted class FQ>` (bd
 * tea-rags-mcp-9fgdi). `classAncestors` is run-global, so a bare class name
 * cannot be the key — two `Base` classes in two files would conflate. `::` and
 * not a dot, because `Outer.Inner` is a legal class FQ and would not split.
 */
export function pythonClassKey(relPath: string, classFq: string): string {
  return `${relPath}::${classFq}`;
}

/** The inverse of {@link pythonClassKey}; `null` for anything not in that shape. */
export function parsePythonClassKey(classKey: string): { readonly relPath: string; readonly classFq: string } | null {
  const at = classKey.indexOf("::");
  if (at <= 0) return null;
  const classFq = classKey.slice(at + 2);
  return classFq.length === 0 ? null : { relPath: classKey.slice(0, at), classFq };
}

/**
 * The dotted FQ a symbol-table definition is addressed by — its scope plus its
 * own short name (bd tea-rags-mcp-graiw). THE spelling rule for a Python class
 * key, stated once: `collectSymbols` pushes every `nameOf`-named container onto
 * `scope`, and `pyNameOf` names a `function_definition` as well as a
 * `class_definition`, so a class declared inside a `def` reads
 * `Authenticator._AuthenticatorSignature` here and nowhere reads
 * `_AuthenticatorSignature`.
 */
export function pythonDeclaredClassFq(def: { readonly scope: readonly string[]; readonly shortName: string }): string {
  return [...def.scope, def.shortName].join(".");
}

/**
 * The MRO key of the class `bareName` names INSIDE `relPath`, or `null` when
 * that file declares no such class — or declares it twice (bd
 * tea-rags-mcp-xasyu).
 *
 * A type name and a file are not yet an address the ancestor walk accepts: the
 * key is DOTTED-FQ-qualified, so a nested `Outer.Inner` has to be spelled from
 * its own definition rather than from the short name the binding carried. This
 * is the same question `resolveBaseKey` asks of a base spelling in
 * `../python-ancestor-policy.ts`, asked here of a receiver's inferred type; it
 * stays in this leaf module because the policy imports from here and not the
 * other way round.
 *
 * `null` is a positive answer, not a residual: the run holds no class under
 * that name in that file, so there is no hierarchy to read and no member to
 * find. A caller that gets it has evidence the bound type is not a class the
 * project declares.
 */
export function pythonBoundClassKey(bareName: string, relPath: string, ctx: CallContext): string | null {
  const declared = lookupPythonSymbolsByShortName(ctx, bareName).filter((def) => def.relPath === relPath);
  if (declared.length !== 1) return null;
  return pythonClassKey(relPath, pythonDeclaredClassFq(declared[0]));
}

/**
 * The MRO key a name that an import ALIASED denotes — `OrderSchema` under
 * `from polar.order.schemas import Order as OrderSchema` is `Order`'s key (bd
 * tea-rags-mcp-w205u, E4.6c).
 *
 * `null` for everything else, and deliberately so: an UNALIASED binding is
 * already what every other read spells, and an import that maps outside the
 * project names no class this run holds. The alias is evidence the local name
 * alone cannot be — `lookupPythonSymbolsByShortName("OrderSchema")` is empty
 * and `resolveTypeFile`'s import pass matches the module text's last segment,
 * never the alias.
 *
 * The re-export hop is the same one `resolveTypeFile` takes: a package that
 * only re-exports the source name declares nothing, so ask which file does.
 */
export function pythonAliasedClassKey(
  localName: string,
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  const binding = findPythonImportBinding(ctx.imports, localName);
  if (binding === null || binding.importedName === binding.localName) return null;
  const mapped = mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (mapped.kind !== "project") return null;
  const direct = pythonBoundClassKey(binding.importedName, mapped.relPath, ctx);
  if (direct !== null) return direct;
  const declaring = mapper.resolveExportedName(mapped.relPath, binding.importedName, ctx);
  return declaring === null ? null : pythonBoundClassKey(binding.importedName, declaring, ctx);
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
    const bound = identifierEntry(imp.importedBindings, root) ?? (imp.importedNames?.includes(root) ? root : undefined);
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
  if (identifierEntry(ctx.classExtends, bareType) !== undefined) return true;
  if (identifierEntry(ctx.classFieldTypes, bareType) !== undefined) return true;
  if (member === undefined) return true;
  return (
    ctx.symbolTable.lookup(`${bareType}#${member}`).length > 0 ||
    ctx.symbolTable.lookup(`${bareType}.${member}`).length > 0
  );
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
    const importedName = identifierEntry(imp.importedBindings, localName);
    if (importedName) return { imp, localName, importedName };
  }
  for (const imp of imports) {
    if (imp.importedBindings) continue; // already consulted above; do not re-answer
    if (imp.importedNames?.includes(localName)) return { imp, localName, importedName: localName };
  }
  return null;
}

/**
 * Which of `candidates` the CALLER's own import binding for `name` points at,
 * or `null` (bd tea-rags-mcp-1v12o.1.5, E5.1a). The single funnel both namesake
 * halves narrow through.
 *
 * A short name declared in two or more project files is only ambiguous to a
 * reader who ignores what the calling file wrote down. polar declares
 * `Subscription` at `models/subscription.py` and `subscription/schemas.py` and
 * `get_client` in six files, and every residual row of that shape carries an
 * import naming exactly one of them. Nothing here guesses: the answer is the
 * caller's statement resolved through {@link PythonImportFileMapper}, or
 * nothing.
 *
 * Why it is not {@link resolveTypeFile}'s existing narrowing. That pass filters
 * candidates against the caller's import SET — every file ANY import maps to —
 * and polar's `customer_portal/service/subscription.py` imports `Subscription`
 * from `polar.models` AND `SubscriptionChargePreview` from
 * `polar.subscription.schemas`. Both candidate files land in the set, two
 * survive, and the pass refuses. The binding for THIS name names one.
 *
 * Three reads, first hit wins, all deterministic: the module the import maps
 * to, the file that DECLARES the imported name one re-export hop on
 * (`from polar.models import Subscription` → `models/__init__.py` →
 * `models/subscription.py`), and the MODULE a package aliases under that name
 * (`from . import _datatable as datatable`). An import that maps outside the
 * project, or onto a file no candidate occupies, is a refusal — not a fallback.
 *
 * With NO binding for the name, the caller's OWN file answers when it declares
 * the name: module scope is what a bare name resolves against, and a file that
 * declares it needs no import. Everything else refuses.
 */
export function pythonImportBoundFile(
  name: string,
  candidates: readonly string[],
  ctx: CallContext,
  mapper: PythonImportFileMapper,
): string | null {
  const binding = findPythonImportBinding(ctx.imports, name);
  if (binding === null) return candidates.includes(ctx.callerFile) ? ctx.callerFile : null;
  const mapped = mapper.mapImportToFile(binding.imp.importText, ctx.callerFile, ctx);
  if (mapped.kind !== "project") return null;
  const hops = [
    mapped.relPath,
    mapper.resolveExportedName(mapped.relPath, binding.importedName, ctx),
    mapper.resolveExportedModule(mapped.relPath, binding.importedName, ctx),
  ];
  for (const hop of hops) if (hop !== null && candidates.includes(hop)) return hop;
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
  const tableMatches = lookupPythonSymbolsByShortName(ctx, bareType);
  if (tableMatches.length === 1) {
    return pythonTypeOwnsMembers(bareType, member, ctx) ? tableMatches[0].relPath : null;
  }

  // Second pass: try to disambiguate via imports — the class file
  // must be one of the files reachable from the caller's imports. Only a
  // `project` verdict names a file the table can hold, so it is the only one
  // that can narrow the candidates.
  if (tableMatches.length > 1) {
    // FIRST, the binding for THIS name (bd tea-rags-mcp-1v12o.1.5, E5.1a). The
    // set-filter below reads every file any import maps to, which conflates
    // "a file this caller imports something from" with "the file this caller's
    // binding for this name names" — polar's
    // `customer_portal/service/subscription.py` imports `Subscription` from
    // `polar.models` and `SubscriptionChargePreview` from
    // `polar.subscription.schemas`, and the set holds both `Subscription`
    // candidates. See {@link pythonImportBoundFile}.
    const bound = pythonImportBoundFile(
      bareType,
      tableMatches.map((def) => def.relPath),
      ctx,
      mapper,
    );
    if (bound !== null) return bound;
    const importedFiles = new Set<string>();
    for (const imp of ctx.imports) {
      const mapped = mapper.mapImportToFile(imp.importText, ctx.callerFile, ctx);
      if (mapped.kind === "project") importedFiles.add(mapped.relPath);
    }
    const filtered = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (filtered.length === 1) return filtered[0].relPath;
    // A miss here is often a package that RE-EXPORTS the name rather than
    // declaring it: netbox's `from core.models import ObjectType` maps to a
    // `__init__.py` that star-imports six siblings, so the filter above kept
    // nothing and the second `ObjectType` in `netbox/graphql/types.py` made
    // guessing illegal — 117 rows. Widening runs only AFTER the direct answer
    // failed, so every row that resolves today resolves to the same file.
    for (const relPath of [...importedFiles]) {
      const declaring = mapper.resolveExportedName(relPath, bareType, ctx);
      if (declaring !== null) importedFiles.add(declaring);
    }
    const followed = tableMatches.filter((def) => importedFiles.has(def.relPath));
    if (followed.length === 1) return followed[0].relPath;
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
