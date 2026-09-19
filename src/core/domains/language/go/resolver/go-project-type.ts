/**
 * A Go type the resolver has typed a receiver with, and — when it knows it —
 * the package that declares it (bd tea-rags-mcp-e6xx, G2-4).
 *
 * Symbol ids carry no package (`Widget#Paint`), so a member lookup composed
 * from the bare name answers with whichever package declares one. Where the
 * resolver PLACED the type — a declared function's result, checked against the
 * package that declares it (`goProjectTypeName`) — the lookup must stay in that
 * package; where it could not (a local's declared type, a struct field, a
 * method's result), `packageDir` is absent and the lookup is package-blind, as
 * every Go lookup was before.
 *
 * The receiver fold (`kernel/receiver-type-propagation.ts`) carries a type as a
 * `TypeRef`, whose only payload is a name, and Go's ports are the fold's only
 * readers of it — so a placed type crosses the fold spelled
 * `<packageDir>::<Type>`, which no Go identifier can spell (the same separator
 * as `goStructClassKey`), and a package-blind one as its bare name.
 */

import type { TypeRef } from "../../../../contracts/types/language.js";

// The package directory lives in `../type-name.ts` beside the map key that
// spells it (`goFunctionReturnTypesKey`), so the walker can derive a package
// from its `relPath` without reaching into the resolver layer; re-exported here
// for this module's existing importers (bd tea-rags-mcp-7h6j0).
export { goPackageDirOf } from "../type-name.js";

export interface GoProjectType {
  readonly typeName: string;
  /** The repo-relative directory of the declaring package; absent when unknown. */
  readonly packageDir?: string;
}

const GO_PLACED_TYPE_SEPARATOR = "::";

/** The `TypeRef` a Go type crosses the receiver fold as. */
export function goProjectTypeRef(type: GoProjectType): TypeRef {
  const name =
    type.packageDir === undefined ? type.typeName : `${type.packageDir}${GO_PLACED_TYPE_SEPARATOR}${type.typeName}`;
  return { form: "instance", name };
}

/** The Go type a fold `TypeRef` name spells ({@link goProjectTypeRef}'s inverse). */
export function goProjectTypeOfRefName(name: string): GoProjectType {
  const separator = name.lastIndexOf(GO_PLACED_TYPE_SEPARATOR);
  if (separator === -1) return { typeName: name };
  return {
    packageDir: name.slice(0, separator),
    typeName: name.slice(separator + GO_PLACED_TYPE_SEPARATOR.length),
  };
}
