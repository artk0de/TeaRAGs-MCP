/**
 * One Swift type's field types, re-assembled from every file that declares
 * them — the READ side of `classFieldTypesByClassKey`
 * (`../type-field-address.ts`).
 *
 * ## Why a union rather than a key composition
 *
 * Go reads the same channel by COMPOSING the exact key it wants, because a Go
 * struct is declared in exactly one file. Swift's `extension` breaks that: one
 * logical type routinely spans `World.swift`, `World+Hooks.swift` and
 * `World+DSL.swift`, so its fields sit under three keys and no single one of
 * them describes the type. Asking for one key would silently return a third of
 * the properties.
 *
 * Nor can the writer merge them: `CodegraphRunState` aggregates per KEY, and
 * its hydration half is first-writer-wins — correct for Python, whose key
 * identifies one class in one file, and destructive for a bare-type-name key,
 * where the first file declaring `Request` would erase every extension of it.
 * The key stays file-qualified and the union happens here.
 *
 * ## Built ONCE per run
 *
 * A per-lookup scan of a run-global map is a non-starter — the map carries one
 * entry per (file, type) across the WHOLE project, and the fold asks it once
 * per chain hop per call site. The index is therefore built once and memoized
 * through {@link RunScopedMemo}, keyed on the identity of the channel object
 * beneath the run scope: the resolver outlives the run (`LanguageFactory`
 * caches it), and `CodegraphRunState#absorb` mutates the channel in place, so
 * neither key alone bounds the entry's lifetime correctly (bd
 * tea-rags-mcp-39xca.6).
 *
 * ## Two filters, both load-bearing
 *
 * The channel is shared by every language in the run. A key whose file is not
 * `.swift` is DROPPED — Go composes the identical `<relPath>::<Type>` shape,
 * and a Go `Context` typing a Swift receiver is the same cross-language
 * mistake `lookupSwiftSymbols` exists to prevent, arriving through a different
 * door. A key no Swift writer could have composed is dropped likewise.
 *
 * ## Collision order
 *
 * A field name declared by two files under one type name cannot occur in
 * compilable Swift: an `extension` may not add a stored property, and a
 * computed one that redeclares a member of the type's own body is a
 * redeclaration error. So the arbitration below settles a case the LANGUAGE
 * already forbids, and exists only so an index built over a half-rewritten
 * tree — or over two same-named types in different modules, this key's known
 * limit — resolves the same way twice.
 *
 * The rule is therefore chosen for STABILITY, not for meaning: keys are folded
 * in sorted order and the first writer of a field name keeps it. Sorting is the
 * whole point — map iteration order is walk order, so an incremental run that
 * re-walks one file would otherwise arbitrate differently from the full run
 * before it, and a resolve answer must not depend on batch composition. There
 * is no own-body-beats-extension marker because recording one would mean
 * inventing a channel to carry it; the caller's own file already outranks this
 * whole index at the read site, which is where the distinction actually pays.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import { RunScopedMemo } from "../../kernel/run-scoped-memo.js";
import { swiftTypeFieldKeyParts } from "../type-field-address.js";
import { isSwiftSourcePath } from "./swift-symbol-lookup.js";

/** `typeName → fieldName → typeName`, unioned across every Swift file of the run. */
type SwiftTypeFieldUnion = Readonly<Record<string, Readonly<Record<string, string>>>>;

const EMPTY_UNION: SwiftTypeFieldUnion = Object.freeze({});

/** Fold every Swift key of the run-global channel into one map per TYPE NAME. */
function buildSwiftTypeFieldUnion(byClassKey: Record<string, Record<string, string>>): SwiftTypeFieldUnion {
  const out: Record<string, Record<string, string>> = {};
  // Sorted, so the collision order above is a property of the project rather
  // than of the order this run happened to walk its files in.
  for (const key of Object.keys(byClassKey).sort()) {
    const parts = swiftTypeFieldKeyParts(key);
    if (parts === undefined || !isSwiftSourcePath(parts.relPath)) continue;
    const fields = byClassKey[key];
    const merged = out[parts.typeName];
    if (merged === undefined) out[parts.typeName] = { ...fields };
    // First writer of a FIELD keeps it; a type seen again contributes only the
    // names no earlier file spelled.
    else for (const [field, type] of Object.entries(fields)) if (!(field in merged)) merged[field] = type;
  }
  return out;
}

/**
 * The run's Swift field union, memoized per channel object. One instance per
 * resolver; `ctx` is threaded as an argument so nothing is allocated per call
 * site beyond the first build of a run.
 */
export class SwiftTypeFieldIndex {
  private readonly unions = new RunScopedMemo<Record<string, Record<string, string>>, SwiftTypeFieldUnion>();

  /** The fields `typeName` declares anywhere in the run, or `undefined`. */
  fieldsOf(typeName: string, ctx: CallContext): Readonly<Record<string, string>> | undefined {
    return this.unionFor(ctx)[typeName];
  }

  private unionFor(ctx: CallContext): SwiftTypeFieldUnion {
    const channel = ctx.classFieldTypesByClassKey;
    // Absent on an index written before the Swift walker published the second
    // address — the reader then answers exactly as it did before it existed.
    if (channel === undefined) return EMPTY_UNION;
    const hit = this.unions.get(ctx.runScope, channel);
    if (hit !== undefined) return hit;
    const fresh = buildSwiftTypeFieldUnion(channel);
    this.unions.set(ctx.runScope, channel, fresh);
    return fresh;
  }
}
