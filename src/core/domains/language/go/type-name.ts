/**
 * The shape of the Go type name the walker RECORDS for what a call returns
 * (`functionReturnTypes`) — defined ONCE for the walker that writes it and the
 * resolver that reads it (bd tea-rags-mcp-e6xx), as `struct-fields.ts` is for
 * the struct-field entries. No imports from either side, so neither depends on
 * the other for it (`.claude/rules/codegraph-walkers.md`).
 *
 * A result type of the declaring package is recorded bare (`Engine`). A
 * package-qualified one keeps its package, spelled as the IMPORT PATH its
 * qualifier binds in the declaring file — `*http.Client` → `net/http.Client`,
 * `*gin.Engine` → `github.com/gin-gonic/gin.Engine`. The qualifier alone means
 * nothing outside that file, and the bare name would let any project type of
 * that name stand in for another package's; the import path is what the
 * resolver's module map answers for.
 *
 * The MAP KEY the entry is stored under is the declaring package
 * (`goFunctionReturnTypesKey`): the channel is absorbed run-global, and a bare
 * key let two packages' namesake `New()`s cross return types — and made the
 * winner depend on which files a run walked (bd tea-rags-mcp-7h6j0).
 *
 * The type name is everything after the LAST `.`: a Go identifier holds no
 * dot, an import path may (`github.com/…`, `gopkg.in/yaml.v3`).
 */

import { posix } from "node:path";

/** The package directory of a Go file: its directory, `""` at the root. A Go package is exactly one directory. */
export function goPackageDirOf(relPath: string): string {
  const dir = posix.dirname(relPath);
  return dir === "." ? "" : dir;
}

/**
 * The run-global `functionReturnTypes` key of the package-level function (or
 * func-valued var) `name` declared by the package whose directory is
 * `packageDir` — `<packageDir>::<name>`, the same separator
 * `goStructClassKey` keys a struct's field map under. The package prefix is
 * what keeps two namesake constructors apart run-global and makes the channel
 * order-independent (bd tea-rags-mcp-7h6j0).
 */
export function goFunctionReturnTypesKey(packageDir: string, name: string): string {
  return `${packageDir}::${name}`;
}

/** A recorded type name split back apart; `importPath` is absent for a type of the declaring package. */
export interface GoRecordedTypeName {
  readonly importPath?: string;
  readonly typeName: string;
}

/** The recorded name of type `typeName` declared by the package imported as `importPath`. */
export function goQualifiedTypeName(importPath: string, typeName: string): string {
  return `${importPath}.${typeName}`;
}

/** Split a recorded type name into its package (when qualified) and its type. */
export function splitGoRecordedTypeName(recorded: string): GoRecordedTypeName {
  const dot = recorded.lastIndexOf(".");
  if (dot === -1) return { typeName: recorded };
  return { importPath: recorded.slice(0, dot), typeName: recorded.slice(dot + 1) };
}
