# Project Registry & Federated Search

> **Status:** Draft **Date:** 2026-03-18 **Priority:** P3

**Goal:** Named projects instead of raw paths, groups of projects for
cross-collection search.

---

## 1. Concept

Three layers:

- **Project** — named binding: `taxdome` → `/home/user/taxdome` → `code_abc123`
- **Group** — set of projects: `taxdome-services` =
  `[taxdome-api, taxdome-auth]`
- **Federated search** — one query across a group, merge via RRF

---

## 2. MCP Tools

```
register_project(path: string, name: string)
register_group(group: string, projects: string[])
```

Search tools get two new optional parameters:

```
semantic_search(query, project?: string, group?: string, path?, collection?)
```

Priority: `collection` > `project` > `group` > `path`. Fully backward
compatible.

---

## 3. Registry Storage

`$TEA_RAGS_DATA_DIR/registry.json` — simple JSON on disk.

```json
{
  "projects": {
    "taxdome-api": {
      "path": "/home/user/taxdome-api",
      "collection": "code_abc123"
    }
  },
  "groups": {
    "taxdome-services": ["taxdome-api", "taxdome-auth", "taxdome-billing"]
  }
}
```

Atomic writes via tmp + rename. No Qdrant dependency for metadata.

---

## 4. Federated Search

RRF (Reciprocal Rank Fusion) merge:

1. Query each collection in group with same parameters
2. Merge results: `score = Σ 1/(k + rank_i)` per collection
3. Sort by RRF score, return top-N

Score-agnostic — works across collections of different sizes.

---

## 5. Relation to Existing Issues

Subsumes `tea-rags-mcp-a9b3` (Federated search across collections). That issue
references mhalder/qdrant-mcp-server v3.2.0 RRF — same approach adopted here.

---

## 6. Out of Scope (First Version)

- Reranker across collections (adaptive bounds are per-collection)
- Parallel query execution (sequential first, optimize later)
- Group-level git signal aggregation
