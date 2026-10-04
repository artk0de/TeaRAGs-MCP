import { describe, expect, it, vi } from "vitest";

import { TEXT_INDEXED_KEYS } from "../../../../../../src/core/adapters/qdrant/filters/text-indexed-exact.js";
import {
  payloadFieldIndexSchema,
  SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS,
} from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaV19MemberSymbolIdsText } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v19-member-symbol-ids-text.js";
import type { IndexStore } from "../../../../../../src/core/domains/maintenance/migration/types.js";

/**
 * An index store holding a live inventory: `ensureIndex` creates an entry only
 * when the field has none, so a second `apply()` sees what the first one left.
 */
function createMockStore(): IndexStore & { inventory: Map<string, string> } {
  const inventory = new Map<string, string>();
  return {
    inventory,
    getSchemaVersion: vi.fn().mockResolvedValue(18),
    ensureIndex: vi.fn(async (_collection: string, field: string, type: string) => {
      if (inventory.has(field)) return false;
      inventory.set(field, type);
      return true;
    }),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn(async (_collection: string, field: string) => inventory.has(field)),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
  };
}

const COLLECTION = "code_test";

/**
 * bd tea-rags-mcp-5xpq4 — a member of a packed test chunk (a tiny example, a
 * scope's setup) is addressed by `find_symbol` through `memberSymbolIds`,
 * matched exactly like `symbolId`: a text token + value pair. That pair is only
 * index-served when the key carries a `text` index.
 */
describe("SchemaV19MemberSymbolIdsText", () => {
  it("declares version 19 and a matching name", () => {
    const migration = new SchemaV19MemberSymbolIdsText(COLLECTION, createMockStore());
    expect(migration.version).toBe(19);
    expect(migration.name).toBe("schema-v19-member-symbol-ids-text");
  });

  it("ensures a text index on memberSymbolIds of an existing collection", async () => {
    const store = createMockStore();

    const result = await new SchemaV19MemberSymbolIdsText(COLLECTION, store).apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "memberSymbolIds", "text");
    expect(store.inventory.get("memberSymbolIds")).toBe("text");
    expect(result.applied).toEqual(["memberSymbolIds:text"]);
  });

  it("is idempotent — a second pass creates nothing", async () => {
    const store = createMockStore();
    const migration = new SchemaV19MemberSymbolIdsText(COLLECTION, store);

    await migration.apply();
    vi.mocked(store.ensureIndex).mockClear();
    await migration.apply();

    const createdOnSecondPass = await Promise.all(vi.mocked(store.ensureIndex).mock.results.map((r) => r.value));
    expect(createdOnSecondPass).toEqual([false]);
  });

  // Declared the supported way: one of the text-indexed keys, so
  // initializeSchema creates it on a new collection, exact matching is routed
  // through `exactMatchOnTextIndexed`, and schema-v16 never drops it.
  it("is a declared, schema-managed text-indexed key", () => {
    expect(TEXT_INDEXED_KEYS).toContain("memberSymbolIds");
    expect(SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS).toContain("memberSymbolIds");
    expect(payloadFieldIndexSchema("memberSymbolIds", "string[]")).toBe("text");
  });
});
