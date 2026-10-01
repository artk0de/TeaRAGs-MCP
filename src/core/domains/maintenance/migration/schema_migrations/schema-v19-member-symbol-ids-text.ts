import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Text-index `memberSymbolIds` on collections that already exist (bd
 * tea-rags-mcp-5xpq4).
 *
 * The test-scope chunker packs several members into one chunk — tiny sibling
 * examples, or the setup of consecutive scopes — names it after its first
 * member and lists every member id in `memberSymbolIds`; `find_symbol`
 * answers a member id from that list. It matches the key like
 * `symbolId` — the text token + value pair of `exactMatchOnTextIndexed` — and
 * that pair is index-served only when the key carries a `text` index.
 * Unindexed, the lookup does not fail: it silently becomes a full payload
 * scan. A new collection gets the index from `initializeSchema`, which creates
 * one for every `TEXT_INDEXED_KEYS` entry.
 *
 * Idempotent and resumable: `ensureIndex` checks for an existing index first,
 * and the pipeline stamps v19 only after the index exists. Only the index is
 * created — the field itself is written by the chunker, so points chunked
 * before the field existed simply carry none.
 */
export class SchemaV19MemberSymbolIdsText implements Migration {
  readonly name = "schema-v19-member-symbol-ids-text";
  readonly version = 19;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "memberSymbolIds", "text");
    return { applied: ["memberSymbolIds:text"] };
  }
}
