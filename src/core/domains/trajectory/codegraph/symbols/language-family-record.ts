/**
 * Run-global class-name maps partitioned by language FAMILY (bd
 * tea-rags-mcp-nbf8q).
 *
 * `classAncestors`, `classPrependedAncestors` and `classExtends` are keyed by
 * the class name a walker writes, and a top-level class's name is its bare name
 * in most languages. One run-wide record let a TypeScript `class Error extends
 * BaseError` and a Ruby `class Error < StandardError` share one key: whichever
 * file the run absorbed last answered `super`, the MRO and the include-by index
 * for BOTH. A resolver never walks another language's hierarchy, so the record
 * is split per family and pass-2 hands a file only its own family's partition.
 *
 * FAMILY, not language, for the reason `ecmascript-symbol-lookup.ts` gives:
 * TypeScript and JavaScript resolve into each other for real (`allowJs`, a
 * `.d.ts` beside its `.js`), so a TS class may extend a JS one. A LITERAL
 * rather than a language capability because `trajectory` may not import the
 * sibling `language` domain; a new language that shares a class namespace with
 * another needs a line here.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";

const ECMASCRIPT_FAMILY = "ecmascript";

/**
 * The family whose class namespace `language`'s walker writes into. Idempotent
 * on a family id, so a caller holding a family (the barrier's per-family schema
 * column types) may pass it wherever a language is expected.
 */
export function languageFamilyOf(language: string): string {
  return language === "typescript" || language === "javascript" ? ECMASCRIPT_FAMILY : language;
}

/**
 * One class-name record per language family.
 *
 * {@link forLanguage} returns the SAME object for the life of the store, so a
 * resolver memo keyed on channel identity (the Python ancestor linearizer
 * cache) still sees one channel per run. A reset seam replaces the whole store.
 */
export class LanguageFamilyRecord<V> {
  private readonly partitions = new Map<string, Record<string, V>>();

  /** `language`'s family partition, created empty on first use. */
  forLanguage(language: string): Record<string, V> {
    const family = languageFamilyOf(language);
    let partition = this.partitions.get(family);
    if (partition === undefined) {
      partition = createIdentifierRecord<V>();
      this.partitions.set(family, partition);
    }
    return partition;
  }

  /** Whether any family's partition holds `key` — for existence questions no family owns. */
  hasInAnyFamily(key: string): boolean {
    for (const partition of this.partitions.values()) if (Object.hasOwn(partition, key)) return true;
    return false;
  }

  /** `family`'s partition if any file of it contributed, without creating one. */
  peekFamily(family: string): Record<string, V> | undefined {
    return this.partitions.get(family);
  }

  /** Every partition, keyed by family, in first-use order. */
  families(): IterableIterator<[string, Record<string, V>]> {
    return this.partitions.entries();
  }

  /** Install a whole partition for `family` — for a map DERIVED per family at the barrier. */
  setFamily(family: string, partition: Record<string, V>): void {
    this.partitions.set(family, partition);
  }

  /**
   * The all-family view. With one family (every single-language run) it IS
   * that family's partition, identity included; with several it is a fresh
   * merge in first-use order where a later family's key shadows an earlier
   * one's — the collision this store exists to avoid, which is why no resolver
   * input is ever read through it. Diagnostics, harnesses and the flag parity
   * test read it.
   */
  view(): Record<string, V> {
    if (this.partitions.size === 1) {
      const [only] = this.partitions.values();
      if (only !== undefined) return only;
    }
    const merged = createIdentifierRecord<V>();
    for (const partition of this.partitions.values()) Object.assign(merged, partition);
    return merged;
  }
}
