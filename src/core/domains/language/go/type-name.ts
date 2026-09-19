/**
 * The shape of the Go type name the walker RECORDS for what a call returns
 * (`functionReturnTypes`) — defined ONCE for the walker that writes it and the
 * resolver that reads it (bd tea-rags-mcp-e6xx), as `struct-fields.ts` is for
 * the struct-field entries. Zero imports, so neither side depends on the other
 * for it (`.claude/rules/codegraph-walkers.md`).
 *
 * A result type of the declaring package is recorded bare (`Engine`). A
 * package-qualified one keeps its package, spelled as the IMPORT PATH its
 * qualifier binds in the declaring file — `*http.Client` → `net/http.Client`,
 * `*gin.Engine` → `github.com/gin-gonic/gin.Engine`. The qualifier alone means
 * nothing outside that file, and the bare name would let any project type of
 * that name stand in for another package's; the import path is what the
 * resolver's module map answers for.
 *
 * The type name is everything after the LAST `.`: a Go identifier holds no
 * dot, an import path may (`github.com/…`, `gopkg.in/yaml.v3`).
 */

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
