---
title: Collections
sidebar_position: 6
---

# Collections

A **collection** is a Qdrant storage unit holding vectors + payloads for one
codebase. TeaRAGs auto-creates one collection per indexed project, so you can
index multiple repositories on a single Qdrant instance without conflict.

## Auto-Derived Collection Names

The collection name is computed from the absolute path of the indexed directory:

```
code_<md5-of-absolute-path>[0..8]
```

Examples:

```
/Users/alice/projects/shop-backend   → code_8f42a1b3
/Users/alice/projects/shop-frontend  → code_d7e9c4f2
/home/bob/work/monorepo              → code_a3f8d2e1
```

This means:

- **Same path → same collection** — re-indexing updates in place, no duplicates
- **Different paths → different collections** — projects stay isolated
- **Moved projects → new collection** — if you rename a directory, TeaRAGs treats
  it as a new codebase (delete the old collection to reclaim space)
- **Symlinks are resolved** — `realpath` is used so `ln -s` doesn't create
  duplicates

## Multi-Project Workflow

You don't need to manage collections manually. Every tool accepts `path` and
resolves the collection internally:

```json
{ "path": "/Users/alice/projects/shop-backend", "query": "payment retry" }
{ "path": "/Users/alice/projects/shop-frontend", "query": "payment retry" }
```

Both work simultaneously against a single Qdrant instance. Your agent can switch
projects by changing the `path` argument.

### Example: split monorepo into sub-collections

For very large monorepos, you can index subtrees as separate collections:

```json
{ "path": "/home/bob/work/monorepo/services/auth" }
{ "path": "/home/bob/work/monorepo/services/payments" }
{ "path": "/home/bob/work/monorepo/services/notifications" }
```

Each gets its own collection, its own git enrichment run, and its own search
space. Useful when:

- The full monorepo is too large to index in one pass
- Teams want isolated trajectory signals (churn in `payments` doesn't leak into
  `auth` rankings)
- Different subtrees use different languages and you want language-aligned stats

## Inspecting Collections

### List all collections

```
/mcp__tea-rags__list_collections
```

Returns the names of all collections on the Qdrant instance, not just ones
created by TeaRAGs. Use this to see what's stored.

### Inspect one collection

```json
{ "name": "code_8f42a1b3" }
```

Returns:

- `vectorSize` — embedding dimensions (768, 1024, 1536, or 3072)
- `pointsCount` — total chunks stored
- `distance` — similarity metric (usually `Cosine`)
- `hybridEnabled` — whether BM25 sparse vectors are configured

Use this to verify a collection exists and check its size before querying.

### Get indexing metadata for a path

`get_index_status` returns richer info than `get_collection_info` — it includes
indexing state, enrichment progress, and infrastructure health:

```json
{ "path": "/Users/alice/projects/shop-backend" }
```

Use `list_collections` to find orphaned collections; use `get_index_status` to
see the state of a specific project.

## Deleting Collections

Three ways to delete, in order of preference:

| Command | When to use |
|---------|-------------|
| `clear_index` (by path) | Normal case — you indexed a project and want to drop it |
| `delete_collection` (by name) | You know the collection name (from `list_collections`) but the path is gone/moved |
| Direct Qdrant HTTP | Only if TeaRAGs is unavailable and you need manual cleanup |

```json
// Preferred
{ "path": "/Users/alice/projects/shop-backend" }

// Fallback when path is gone
{ "name": "code_8f42a1b3" }
```

All three operations are irreversible and destroy the full index. You'll need to
re-run `index_codebase` to restore.

## Creating Collections Manually

Rare — `index_codebase` creates collections automatically. Manual creation is
only needed when:

- Building a custom pipeline that bypasses `index_codebase`
- Testing with a specific vector configuration

```json
{
  "name": "custom_collection",
  "distance": "Cosine",
  "enableHybrid": true
}
```

`enableHybrid: true` provisions BM25 sparse vectors for `hybrid_search`. If you
forget this, `hybrid_search` will error on the collection.

## Collection Lifecycle

```
index_codebase          → creates `code_<hash>` if missing
index_codebase (again)  → incremental update on the same collection
index_codebase --forceReindex → atomic swap via versioned alias (zero-downtime)
clear_index             → deletes the collection
```

### Zero-downtime re-index

`index_codebase` with `forceReindex: true` does not delete the current collection
immediately. It builds a new versioned collection (`code_<hash>_v2`) in
background while queries continue against the old one, then atomically switches
an alias. See [`/tea-rags:force-reindex`](/usage/skills/) for the skill-driven
workflow.

## Name Collisions Across Qdrant Instances

If you share a Qdrant instance across multiple developers, collection names are
derived from **absolute paths on the indexing machine**. Two devs with different
home directories will get different collections for the same repo — which is
usually what you want (private git signals per dev).

If you need a **shared collection** across a team, pass an explicit `collection`
parameter to all tools:

```json
{
  "collection": "team_shop_backend",
  "path": "/Users/alice/projects/shop-backend",
  "query": "..."
}
```

The `collection` param overrides the auto-derived name.

## See Also

- [MCP Tools Atlas](./mcp-tools) — `list_collections`, `get_collection_info`,
  `create_collection`, `delete_collection`
- [Indexing Repositories](/usage/indexing-repositories) — indexing workflow
- [`/tea-rags:force-reindex`](/usage/skills/) — zero-downtime full re-index
