/**
 * The run-global ADDRESS of a Swift type's field types — the one place the key
 * shape is written down, imported by both the walker that composes it and the
 * resolver that reads it (`.claude/rules/codegraph-walkers.md`: define a
 * walker↔resolver marker ONCE, in a zero-import leaf at the language root, and
 * never let the resolver import it from the walker).
 *
 * The channel is `classFieldTypesByClassKey` — run-global, hydrated across the
 * pass-1 barrier — and the key is `<relPath>::<TypeName>`, the same shape Go's
 * structs use (`go/struct-fields.ts`) and one segment shorter than Python's
 * `<relPath>::<dotted FQ>`. The file prefix is not decoration:
 *
 *   - the map is shared by EVERY language in a run, so the prefix is what keeps
 *     a Go `Context` and a Swift `Context` in separate entries — and what lets
 *     the Swift reader drop every key that is not `.swift` at all;
 *   - `CodegraphRunState#absorb` merges per KEY, so two files declaring one
 *     type name land in two entries rather than overwriting each other. That
 *     matters more for Swift than for any other language: a type is routinely
 *     re-opened by `extension` in several files, and a bare-type-name key would
 *     let the hydration merge — which is first-writer-wins by design, and is
 *     shared with Python, where the per-file key makes that correct — silently
 *     drop every extension's contribution.
 *
 * Re-assembling one logical type from its several keys is therefore the
 * READER's job, and it is deliberately not encoded here: this module knows the
 * key shape and nothing about how many files spell it.
 */

/** The run-global key of the field types `relPath` declares for `typeName`. */
export function swiftTypeFieldKey(relPath: string, typeName: string): string {
  return `${relPath}::${typeName}`;
}

/**
 * The TYPE-NAME half of a key this module composed, or `undefined` when the key
 * was composed by another language.
 *
 * `::` is the separator, and only the LAST occurrence is the join: a relPath
 * cannot contain `::` on any filesystem this indexes, but a Python key spells a
 * dotted FQ after it and a nested type could in principle carry one too, so
 * reading from the right is what keeps the halves unambiguous. A key with no
 * separator, or with nothing on either side of it, is not ours.
 */
export function swiftTypeFieldKeyParts(key: string): { relPath: string; typeName: string } | undefined {
  const cut = key.lastIndexOf("::");
  if (cut <= 0) return undefined;
  const typeName = key.slice(cut + 2);
  return typeName.length === 0 ? undefined : { relPath: key.slice(0, cut), typeName };
}
