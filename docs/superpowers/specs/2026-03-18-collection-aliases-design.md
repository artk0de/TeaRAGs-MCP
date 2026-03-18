# Collection Aliases — Zero-Downtime Reindexing

> **Status:** Approved **Date:** 2026-03-18

**Goal:** Search available 100% during forceReindex via Qdrant collection
aliases. Alias points to active versioned collection; reindex builds new version
in background, then atomically switches alias.

---

## 1. Scope

- Aliases apply **only to forceReindex**. Incremental reindex
  (`reindex_changes`) works in-place as today.
- Search flow (semantic, hybrid, rank, find_similar) **does not change** —
  Qdrant transparently resolves aliases in all read AND write operations
  (search, scroll, upsert, delete).
- MCP tool schemas **do not change** — no new parameters for users.

**Qdrant alias guarantees:** Qdrant aliases are fully transparent for all
operations including upsert, delete, search, scroll. See
[Qdrant docs: Collections — Aliases](https://qdrant.tech/documentation/concepts/collections/#collection-aliases).

---

## 2. Versioned Collection Naming

Format: `{collectionName}_v{version}`

- `code_abc123_v1`, `code_abc123_v2`, etc.
- Version stored in snapshot meta (`aliasVersion: number`).
- Alias name = original `collectionName` (e.g., `code_abc123`).

First indexing also uses aliases: creates `_v1` + alias.

---

## 3. forceReindex Flow

```
forceReindex(path):
  1. collectionName = resolveCollectionName(path)       // "code_abc123"
  2. aliasVersion = snapshotMeta?.aliasVersion ?? 0
  3. newVersion = aliasVersion + 1                      // 1 for first index, 2+ for re-index
  4. versionedName = "{collectionName}_v{newVersion}"   // "code_abc123_v1" or "_v2"
  5. qdrant.createCollection(versionedName, ...)
  6. index all files into versionedName
  7. IF aliasVersion == 0 (first index):
       qdrant.createAlias(collectionName, versionedName)
     ELSE:
       oldVersioned = "{collectionName}_v{aliasVersion}"
       qdrant.switchAlias(collectionName, oldVersioned, versionedName)  // atomic
       qdrant.deleteCollection(oldVersioned)                            // cleanup
  8. snapshot.aliasVersion = newVersion
```

Search remains available throughout steps 5-6 via alias → previous version.

---

## 4. QdrantManager API

New methods on `QdrantManager`:

```typescript
createAlias(alias: string, collection: string): Promise<void>
switchAlias(alias: string, fromCollection: string, toCollection: string): Promise<void>
deleteAlias(alias: string): Promise<void>
isAlias(name: string): Promise<boolean>
listAliases(): Promise<Array<{ aliasName: string; collectionName: string }>>
```

`switchAlias` uses Qdrant `update_aliases` API with atomic actions:
`[{ delete_alias: { alias_name } }, { create_alias: { alias_name, collection_name } }]`.

`isAlias` uses `GET /aliases` to check if a name appears in the alias list (vs
being a real collection name). Used by migration logic (section 7) and orphan
cleanup (section 5).

`listAliases` used by orphan cleanup to find which versioned collection an alias
points to.

---

## 5. Error Handling & Cleanup

**Failure during indexing v2:**

1. Delete incomplete `versionedName` collection
2. Alias stays on previous version (v1)
3. Search unaffected

**No checkpoint recovery.** Retry starts from scratch. Resume can be added later
as a separate optimization.

**Orphan cleanup on startup:** Before forceReindex starts, scan for orphaned
versioned collections:

1. `listAliases()` → find which `{collectionName}_v{N}` the alias points to
2. `listCollections()` → find all `{collectionName}_v*` collections
3. Delete any `{collectionName}_v*` that is NOT the alias target

This handles crashes between steps 7 and 8, or between switchAlias and
deleteCollection.

**New error class:** `AliasOperationError extends InfraError` — for failed alias
CRUD operations.

---

## 6. Snapshot

- Snapshot path unchanged: `snapshots/{collectionName}/` (alias name, not
  versioned name).
- New field in snapshot meta: `aliasVersion: number` (distinct from existing
  `version: "3"` which is the snapshot format version).
- Incremental reindex reads/writes snapshot as today — no changes needed.

---

## 7. Backward Compatibility (Migration)

Existing collections without aliases (e.g., `code_abc123` is a real collection,
not an alias):

1. `isAlias("code_abc123")` returns false → migration needed
2. Create `code_abc123_v2`, index all files into it
3. Delete real collection `code_abc123` (brief unavailability window — single
   delete operation, typically <100ms)
4. Create alias `code_abc123` → `code_abc123_v2`
5. Snapshot gets `aliasVersion: 2`

**Migration downtime:** Steps 3-4 create a brief window (~100ms) where neither
collection nor alias exists. This is a one-time migration cost. After migration,
all subsequent forceReindex operations are zero-downtime via atomic alias
switch.

After migration, all operations go through alias.

---

## 8. What Does NOT Change

| Component                    | Change                                       |
| ---------------------------- | -------------------------------------------- |
| `resolveCollectionName()`    | None                                         |
| `resolveCollection()`        | None                                         |
| Search flow (all strategies) | None — Qdrant resolves aliases transparently |
| Incremental reindex          | None — works in-place through alias          |
| MCP tool schemas             | None — no new parameters                     |
| Snapshot path structure      | None — only `aliasVersion` added to meta     |

---

## 9. Files to Modify

### New files

| File                                  | Contents                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| `src/core/adapters/qdrant/aliases.ts` | `createAlias`, `switchAlias`, `deleteAlias`, `isAlias`, `listAliases` |

### Modified files

| File                                               | Change                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/core/adapters/qdrant/errors.ts`               | Add `AliasOperationError`                                                |
| `src/core/adapters/qdrant/client.ts`               | Expose alias methods or delegate to aliases module                       |
| `src/core/domains/ingest/indexing.ts`              | forceReindex flow: versioned collections + alias switch + orphan cleanup |
| `src/core/domains/ingest/sync/sharded-snapshot.ts` | Add `aliasVersion` to snapshot meta                                      |
