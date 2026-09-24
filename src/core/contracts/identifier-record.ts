/**
 * Records keyed by a SOURCE IDENTIFIER — a local's name, a field's name, a
 * class's name (bd tea-rags-mcp-f4ce0).
 *
 * Source code names things `toString`, `constructor`, `valueOf` and
 * `__proto__`. On a `{}` record those keys resolve to `Object.prototype`
 * members: `(bucket[name] ??= []).push(...)` finds the inherited function, skips
 * the `??=`, and throws; `record["__proto__"] = v` resets the prototype instead
 * of storing an entry; a read of an ABSENT `constructor` returns `Object`.
 *
 * Writers build such records with {@link createIdentifierRecord} (null
 * prototype — every key is an ordinary own key). Readers go through
 * {@link identifierEntry}, because a record that crossed a JSON spill or a
 * worker boundary has `Object.prototype` again: the null prototype protects the
 * writer, only an own-key read protects the reader.
 */

/** An empty record with no prototype, safe to key by any source identifier. */
export function createIdentifierRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** The OWN entry of `record` under `key` — never an inherited `Object.prototype` member. */
export function identifierEntry<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}
