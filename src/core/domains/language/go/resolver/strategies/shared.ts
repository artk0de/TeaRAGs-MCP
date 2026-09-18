/**
 * Shared inputs and helpers for the Go symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection — the old `GoCallResolver(composer, mode)` pair. The
 * `composer` builds `Type#member` / `Type.member` candidate ids per the
 * project-wide symbolId convention; `mode` controls ambiguous-candidate
 * resolution.
 *
 * `resolveByLocalType` and `isKnownTypeSymbol` are the two helpers the
 * typed-receiver strategies (`localBinding`, `returnTypeBinding`) share —
 * factored here so they live once.
 */

import { posix } from "node:path";

import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type ImportRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../../contracts/types/language.js";
import type { GoModuleMap, GoModuleMapCache } from "../go-module-map.js";
import { lookupGoSymbols, lookupGoSymbolsByShortName } from "../go-symbol-lookup.js";
import { selectGoMember } from "../struct-member-selection.js";

export interface ResolverConfig {
  composer: SymbolIdComposer;
  mode: AmbiguousResolveMode;
  /**
   * The project's go.mod module map, read per root (bd tea-rags-mcp-e6xx).
   * Absent — a strategy built on its own in a test — means no module is known,
   * and import paths match GOPATH-style, as the package's exact directory.
   */
  moduleMaps?: GoModuleMapCache;
}

/**
 * Resolve a typed-receiver call: try `Type#member` (instance form) first, then
 * `Type.member` (static form). Returns `null` — never a global short-name
 * fallback — when neither form exists; the calling strategy turns that `null`
 * into a guard DROP. Mirrors the python-resolver step 0 contract.
 *
 * When `Type` declares the member in NEITHER form, the member may still be
 * PROMOTED from a struct `Type` embeds — gin's `engine.GET(...)` is
 * `RouterGroup#GET` (bd tea-rags-mcp-e6xx). `selectGoMember` answers that with
 * Go's shallowest-depth rule; it runs only on an empty direct lookup, so a type
 * that declares the member itself resolves exactly as it did before.
 */
export function resolveByLocalType(
  cfg: ResolverConfig,
  typeName: string,
  member: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const instanceForm = cfg.composer.compose(typeName, member, { methodKind: "instance" });
  const staticForm = cfg.composer.compose(typeName, member, { methodKind: "static" });
  const instanceHits = lookupGoSymbols(ctx, instanceForm);
  const instance = pickSingleCandidate(instanceHits, cfg.mode);
  if (instance) return { targetRelPath: instance.relPath, targetSymbolId: instance.symbolId };
  const staticHits = lookupGoSymbols(ctx, staticForm);
  const staticHit = pickSingleCandidate(staticHits, cfg.mode);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  if (instanceHits.length > 0 || staticHits.length > 0) return null;
  const promoted = selectGoMember(typeName, member, ctx, cfg.composer);
  return promoted?.kind === "method" ? promoted.target : null;
}

/**
 * Safety gate for function-return-type binding: a declared return type only
 * binds when it names a concrete type that EXISTS as a symbol in the table
 * (`type Engine struct {...}` → symbol `Engine`). Interfaces, builtins
 * (`string`, `error`), and external `pkg.Type`s have no project-local type
 * symbol, so they SKIP rather than fabricate an edge. Matched by exact fqName
 * first (top-level type, `Engine`), then by short name (nested / scoped type
 * declarations) — either match means a real type symbol was extracted. Only a
 * GO declaration counts: a TypeScript `Widget` is no evidence about a Go one.
 */
export function isKnownTypeSymbol(typeName: string, ctx: CallContext): boolean {
  if (lookupGoSymbols(ctx, typeName).length > 0) return true;
  return lookupGoSymbolsByShortName(ctx, typeName).length > 0;
}

/** The package directory of a Go file: its directory, `""` at the root. A Go package is exactly one directory. */
export function goPackageDirOf(relPath: string): string {
  const dir = posix.dirname(relPath);
  return dir === "." ? "" : dir;
}

/**
 * Whether `receiver` is the name `imp` binds in the importing file: the alias
 * the walker recorded when the source spells one (bd tea-rags-mcp-e6xx — once
 * aliased, the path's last segment is NOT in scope), else the path's last
 * `/`-segment. A dot or blank import binds no qualifier at all.
 */
export function importMatchesReceiver(imp: ImportRef, receiver: string): boolean {
  const explicit = imp.importedNames?.[0];
  if (explicit !== undefined) return explicit === receiver && explicit !== "." && explicit !== "_";
  const segments = imp.importText.split("/");
  const last = segments[segments.length - 1] ?? "";
  return last === receiver;
}

/**
 * The repo-relative package directory an import names, `undefined` when it is
 * not a project package (bd tea-rags-mcp-e6xx). With go.mod modules declared
 * the module map answers — `<module>/<subpath>` is `<subpath>` beneath that
 * go.mod, and the standard library or a dependency is no project package;
 * without one (GOPATH-shaped fixtures) the import path is the directory.
 */
export function goImportPackageDir(importText: string, modules: GoModuleMap | undefined): string | undefined {
  if (modules?.declaresModules) return modules.packageDirOf(importText);
  return importText.replace(/^\.\//, "");
}

/**
 * `qualifier.member` where `qualifier` names an imported project package: the
 * package-level declaration `member` (`symbolId` equal to it — a method is
 * never package-qualified) in that package's one directory, `null` when the
 * qualifier names no import, the import is no project package, or the
 * directory declares no single such name. Shared by `importMatch` and the
 * package-qualified generic instantiation (bd tea-rags-mcp-e6xx).
 */
export function resolveImportedPackageMember(
  cfg: ResolverConfig,
  qualifier: string,
  member: string,
  ctx: CallContext,
): SymbolResolutionTarget | null {
  const match = ctx.imports.find((imp) => importMatchesReceiver(imp, qualifier));
  if (!match) return null;
  const packageDir = goImportPackageDir(match.importText, cfg.moduleMaps?.forRoot(ctx.projectRoot));
  if (packageDir === undefined) return null;
  const candidates = lookupGoSymbolsByShortName(ctx, member).filter(
    (def) => def.symbolId === member && goPackageDirOf(def.relPath) === packageDir,
  );
  const target = pickSingleCandidate(candidates, cfg.mode);
  return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
}
