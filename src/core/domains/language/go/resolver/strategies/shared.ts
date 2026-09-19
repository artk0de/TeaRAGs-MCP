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
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../../contracts/types/language.js";
import { goImportBoundName, goImportPathElementName } from "../../import-binding.js";
import { goLocalAt } from "../../local-scope.js";
import { splitGoRecordedTypeName } from "../../type-name.js";
import { preferGoDefaultBuild } from "../go-build-constraints.js";
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
  const instanceHits = preferGoDefaultBuild(lookupGoSymbols(ctx, instanceForm), ctx);
  const instance = pickSingleCandidate(instanceHits, cfg.mode);
  if (instance) return { targetRelPath: instance.relPath, targetSymbolId: instance.symbolId };
  const staticHits = preferGoDefaultBuild(lookupGoSymbols(ctx, staticForm), ctx);
  const staticHit = pickSingleCandidate(staticHits, cfg.mode);
  if (staticHit) return { targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId };
  if (instanceHits.length > 0 || staticHits.length > 0) return null;
  const promoted = selectGoMember(typeName, member, ctx, cfg.composer);
  return promoted?.kind === "method" ? promoted.target : null;
}

/**
 * Safety gate for function-return-type binding: a declared return type only
 * binds when it names a concrete type that EXISTS as a symbol in the table
 * (`type Engine struct {...}` → symbol `Engine`). Builtins (`string`,
 * `error`) have no project-local type symbol, so they SKIP rather than
 * fabricate an edge. It answers for a BARE name only: a package-qualified one
 * is `goProjectTypeName`'s, because "some type of that name exists" is no
 * evidence about another package's type. Matched by exact fqName
 * first (top-level type, `Engine`), then by short name (nested / scoped type
 * declarations) — either match means a real type symbol was extracted. Only a
 * GO declaration counts: a TypeScript `Widget` is no evidence about a Go one.
 */
export function isKnownTypeSymbol(typeName: string, ctx: CallContext): boolean {
  if (lookupGoSymbols(ctx, typeName).length > 0) return true;
  return lookupGoSymbolsByShortName(ctx, typeName).length > 0;
}

/**
 * The PROJECT type a recorded return type denotes (`../../type-name.ts`), bare,
 * or `undefined` when it denotes none (bd tea-rags-mcp-e6xx):
 *   - a bare name is a type of the package that declares the function
 *     (`calleePackageDir`, `undefined` for a method, whose package the
 *     resolver cannot know) — or of a package some file dot-imports, which the
 *     record cannot tell apart (G2-3: under `. "net/http"`, `func mk() *Client`
 *     records the bare `Client` of `http.Client`). It counts when the callee's
 *     package declares it. Otherwise, in a caller file that dot-imports
 *     anything, it types nothing — the callee is almost always of the caller's
 *     own file or package, and a dot-imported type is indistinguishable from a
 *     project namesake; and elsewhere it passes the package-blind known-type
 *     gate (`isKnownTypeSymbol`), as before;
 *   - a package-qualified one (`net/http.Client`) counts only when its import
 *     path names a PROJECT package (module map, else GOPATH-shaped) whose
 *     directory declares that type. The standard library and every dependency
 *     name no project package, so a project namesake never stands in for them.
 * The bare name is what comes back: symbol ids carry no package, and every
 * lookup downstream composes from it.
 */
export function goProjectTypeName(
  recorded: string,
  cfg: ResolverConfig,
  ctx: CallContext,
  calleePackageDir: string | undefined,
): string | undefined {
  const { importPath, typeName } = splitGoRecordedTypeName(recorded);
  if (importPath === undefined) {
    if (calleePackageDir !== undefined && goPackageDeclaresType(typeName, calleePackageDir, ctx)) return typeName;
    if (ctx.imports.some((imp) => imp.importedNames?.[0] === GO_DOT_IMPORT_NAME)) return undefined;
    return isKnownTypeSymbol(typeName, ctx) ? typeName : undefined;
  }
  const packageDir = goImportPackageDir(importPath, cfg.moduleMaps?.forRoot(ctx.projectRoot));
  if (packageDir === undefined) return undefined;
  return goPackageDeclaresType(typeName, packageDir, ctx) ? typeName : undefined;
}

/** Whether the Go package in `packageDir` declares the type `typeName`. */
function goPackageDeclaresType(typeName: string, packageDir: string, ctx: CallContext): boolean {
  return lookupGoSymbols(ctx, typeName).some((def) => goPackageDirOf(def.relPath) === packageDir);
}

/** The import name that puts a package's names in the importing file's own scope. */
const GO_DOT_IMPORT_NAME = ".";

/**
 * The package directories a bare identifier of the caller's file may name a
 * declaration of: the caller's own package first, then every dot-imported
 * PROJECT package. A bare name is never another package's (bd
 * tea-rags-mcp-e6xx).
 */
export function goBareNamePackageDirs(cfg: ResolverConfig, ctx: CallContext): string[] {
  const dirs = [goPackageDirOf(ctx.callerFile)];
  for (const imp of ctx.imports) {
    if (imp.importedNames?.[0] !== GO_DOT_IMPORT_NAME) continue;
    const dir = goImportPackageDir(imp.importText, cfg.moduleMaps?.forRoot(ctx.projectRoot));
    if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * The package a BARE callee (`New()`, `engine()`) belongs to: the first of
 * `goBareNamePackageDirs` that declares a package-level function of that name;
 * the caller's own package when none of the whole project does (a
 * package-level func-valued var, gin's `var engine = sync.OnceValue(…)`, is no
 * symbol); `null` when a local function value of that name is in scope, or
 * when only packages the caller cannot name bare declare it — a namesake
 * declared elsewhere is whose return type the run-global map may hold.
 */
function goBareCalleePackageDir(callee: string, cfg: ResolverConfig, ctx: CallContext, atLine: number): string | null {
  if (goLocalAt(ctx, callee, atLine)) return null;
  const declaredIn = new Set(
    lookupGoSymbolsByShortName(ctx, callee)
      .filter((def) => def.symbolId === callee)
      .map((def) => goPackageDirOf(def.relPath)),
  );
  const inScope = goBareNamePackageDirs(cfg, ctx);
  if (declaredIn.size === 0) return inScope[0];
  return inScope.find((dir) => declaredIn.has(dir)) ?? null;
}

/**
 * The type a call-bound local holds (`x := New()`, `x := pkg.New()`,
 * `x := v.Method()`) or a bare call's result (`engine().GET`): the callee's
 * recorded return type from the run-global `functionReturnTypes`, keyed by the
 * callee's bare name, when it denotes a project type of the callee's package
 * (`goProjectTypeName`). `undefined` when either is missing. `atLine` is where
 * the callee is evaluated — the call binding's own line, or the call's.
 *
 * A bare callee belongs to the package `goBareCalleePackageDir` finds for it
 * (G2-3); none — a local function value, a namesake only another package
 * declares — types nothing.
 *
 * A qualified callee's qualifier is read as Go reads it (bd tea-rags-mcp-e6xx,
 * G2-1):
 *   - a LOCAL in scope on `atLine` (`goLocalAt` — a local, parameter, named
 *     result or receiver, the one that shadows any import of its name) makes
 *     it a method call on a value, and a method's return type is keyed by the
 *     method name, so the map is read by bare name — with no package known;
 *   - else an IMPORT binding it names a package, which answers only when it is
 *     a project package declaring the function: the run-global map is keyed by
 *     bare name, so without the check a standard-library constructor took the
 *     return type of any project function of the same name;
 *   - else it is neither, and it types nothing. The bare-name read here is how
 *     `echo.New()` — a package whose bound name the resolver once failed to
 *     derive — took the project's `New() *Server`. A package-level var is a
 *     value too, but no channel carries one, so it fails closed with the rest.
 */
export function goCallResultType(
  callee: string,
  cfg: ResolverConfig,
  ctx: CallContext,
  atLine: number,
): string | undefined {
  const dot = callee.lastIndexOf(".");
  const name = dot === -1 ? callee : callee.slice(dot + 1);
  let calleePackageDir: string | undefined;
  if (dot === -1) {
    const packageDir = goBareCalleePackageDir(name, cfg, ctx, atLine);
    if (packageDir === null) return undefined;
    calleePackageDir = packageDir;
  } else {
    const qualifier = callee.slice(0, dot);
    if (goLocalAt(ctx, qualifier, atLine) === undefined) {
      const packageDir = importedPackageDirOf(cfg, qualifier, ctx);
      if (packageDir === undefined || packageDir === null) return undefined;
      if (packageLevelDeclarations(name, packageDir, ctx).length === 0) return undefined;
      calleePackageDir = packageDir;
    }
  }
  const returnType = ctx.functionReturnTypes?.[name];
  return returnType === undefined ? undefined : goProjectTypeName(returnType, cfg, ctx, calleePackageDir);
}

/** The package directory of a Go file: its directory, `""` at the root. A Go package is exactly one directory. */
export function goPackageDirOf(relPath: string): string {
  const dir = posix.dirname(relPath);
  return dir === "." ? "" : dir;
}

/**
 * The import the qualifier `qualifier` names in the caller's file, `undefined`
 * when none binds it (bd tea-rags-mcp-e6xx, G2-1). The name an import binds is
 * its alias when the source spells one; else, for a PROJECT package whose
 * directory the module map can read, the name its own `package` clause
 * declares (`GoModuleMap#packageNameOf` — `api/v1` may be `package v1`); else
 * the name Go's tooling assumes from the path (`goImportBoundName`: `/v4`
 * dropped, `yaml.v3` → `yaml`, `go-json` → `json`). Only when no import binds
 * it that way does an import whose clause is unread answer for its last path
 * element (`goImportPathElementName`), the name such a package may declare
 * instead. A dot or blank import binds no qualifier at all.
 */
export function goImportNamedBy(cfg: ResolverConfig, qualifier: string, ctx: CallContext): ImportRef | undefined {
  const modules = cfg.moduleMaps?.forRoot(ctx.projectRoot);
  const unreadClauses: ImportRef[] = [];
  for (const imp of ctx.imports) {
    if (imp.importedNames?.[0] !== undefined) {
      if (goImportBoundName(imp) === qualifier) return imp;
      continue;
    }
    const packageDir = goImportPackageDir(imp.importText, modules);
    const declared = packageDir === undefined ? undefined : modules?.packageNameOf(packageDir);
    if (declared === undefined) unreadClauses.push(imp);
    if ((declared ?? goImportBoundName(imp)) === qualifier) return imp;
  }
  return unreadClauses.find((imp) => goImportPathElementName(imp) === qualifier);
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
  const packageDir = importedPackageDirOf(cfg, qualifier, ctx);
  if (packageDir === undefined || packageDir === null) return null;
  const candidates = packageLevelDeclarations(member, packageDir, ctx);
  const target = pickSingleCandidate(preferGoDefaultBuild(candidates, ctx), cfg.mode);
  return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
}

/**
 * The package directory the qualifier `qualifier` names in the caller's file:
 * `undefined` when no import binds it (a value, or nothing), `null` when the
 * import it binds is no project package (`goImportPackageDir`).
 */
function importedPackageDirOf(cfg: ResolverConfig, qualifier: string, ctx: CallContext): string | null | undefined {
  const match = goImportNamedBy(cfg, qualifier, ctx);
  if (!match) return undefined;
  return goImportPackageDir(match.importText, cfg.moduleMaps?.forRoot(ctx.projectRoot)) ?? null;
}

/** The package-level Go declarations of `name` (`symbolId` equal to it — never a method) in `packageDir`. */
function packageLevelDeclarations(name: string, packageDir: string, ctx: CallContext): SymbolDefinition[] {
  return lookupGoSymbolsByShortName(ctx, name).filter(
    (def) => def.symbolId === name && goPackageDirOf(def.relPath) === packageDir,
  );
}
