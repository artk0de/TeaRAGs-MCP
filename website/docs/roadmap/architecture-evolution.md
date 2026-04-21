---
title: "Architecture Evolution"
sidebar_position: 1
---

# Architecture Evolution

Structural changes planned for the core — refactorings, dependency moves, and packaging improvements that don't add new user-facing capabilities but meaningfully reshape what's underneath.

The items below reflect the current open roadmap (tracked in [beads](https://github.com/oeed/beads), issue IDs shown). Scope and order may shift; this page is a snapshot, not a contract.

---

## Explore / API layer GRASP refactoring

**Epic**: `tea-rags-mcp-dq9u` · P3

The `ExploreFacade` has grown by accretion — each new preset, each new tool, adds a code path that mostly duplicates the previous one. The refactor splits this into:

- **`BaseSearchStrategy`** — a common base class for semantic/hybrid/rank strategies, eliminating the strategy-by-strategy copy-paste that currently exists around filter building, rerank invocation, and response shaping (`tea-rags-mcp-yjhu`).
- **`FilterBuilder`** — a unified abstraction for Qdrant filter construction. Today filter composition is scattered across facades, rerank logic, and strategy classes. The FilterBuilder centralises the typed-filter → Qdrant-condition translation (`tea-rags-mcp-vg9e`).
- **API-layer GRASP cleanup** — applies the same responsibility-reassignment pattern to the `api/` composition root (`tea-rags-mcp-h711`).

**Why it matters:** the current code structure is the primary friction when adding new trajectory providers or new rerank presets. Every addition touches more files than it should. The refactor makes [extending providers](/extending/adding-providers) and [custom enrichments](/extending/custom-enrichments) structurally cheaper.

---

## MCP schema & documentation improvements

**Epic**: `tea-rags-mcp-xyo0` · P3

Two structural changes to how the server describes itself to agents:

- **Schema compaction wave 2** (`tea-rags-mcp-uemo`) — further reduction of tool-parameter schema size via enum grouping. Wave 1 already squeezed a lot; wave 2 targets the remaining repetition in preset descriptions and filter definitions.
- **Per-resource schema documentation** (`tea-rags-mcp-4d8j`) — move schema docs from the tool descriptions (where they inflate every call) to dedicated [MCP resources](/api/resources) read on demand.

**Why it matters:** schema size is a per-call tax on every MCP round-trip. Shrinking it saves tokens on every agent session without reducing expressive power.

---

## CLI executable

**Epic**: `tea-rags-mcp-hf2q` · P2

Replace the manual `"command": "node /path/to/build/index.js"` MCP config entry with a `tea-rags` CLI:

- `tea-rags serve` — run the MCP server (the default today)
- `tea-rags plugin install|update` — manage IDE plugin integration from the CLI

`package.json` gets a `bin` field; users install via `npm install -g tea-rags` and reference it as `tea-rags` in MCP config. Removes the current friction of knowing the exact build path.

---

## Major dependency upgrades

**Epic**: `tea-rags-mcp-6fsk` · P2

Dependency bumps that require breaking-change handling, tracked as an epic because they tend to cascade through tests and types:

- **TypeScript 5.9 → 6.x** (`tea-rags-mcp-noc7`) — new compiler options, possible type narrowing regressions.
- **`@qdrant/js-client-rest` 1.16 → 1.17** (`tea-rags-mcp-doe6`) — aligns with server-side features like [MMR reranking](/roadmap/future-layers#mmr-and-multi-preset-reranking) and 2-hop ACORN filters.

Already landed under the same epic: ESLint 10.x, Zod 4.x, OpenAI SDK 6.x, `--detect-async-leaks` for vitest.

**Why it matters:** keeps the project on a supported stack and unlocks server-side Qdrant features that need the newer client.

---

## Infrastructure & scaling

**Epic**: `tea-rags-mcp-0xyn` · P3

Production-reliability foundations that aren't user-visible but matter for long-running deployments:

- **Structured logging with pino** (`tea-rags-mcp-rwom`) — replace ad-hoc console logging with a structured logger. Enables proper log aggregation and level-based filtering.
- **Streaming chunk enrichment** (`tea-rags-mcp-zky0`) — run chunk-level git enrichment in parallel with embedding instead of strictly after. Halves end-to-end indexing time for monorepos.
- **Git data caching** (`tea-rags-mcp-75k`) — formalise the L2 disk cache with explicit TTL and size-based eviction beyond the current HEAD-keyed invalidation.
- **Parallel processing workers** (`tea-rags-mcp-pft`) — revisit the chunker pool distribution strategy (`tea-rags-mcp-b32`) for better CPU utilisation on large codebases.

See [Cache Lifecycle](/architecture/cache-lifecycle) for the current state these changes build on.

---

## Design principles

Everything above follows the same rules:

1. **No feature flags for architecture changes.** Structural refactors land fully or not at all. Half-finished internal abstractions are worse than none.
2. **Preserve the public contract.** `App` (api/public) is the only thing MCP tools know about. Refactors are welcome *below* that line; the line itself is stable.
3. **Benchmark before declaring done.** Architectural changes that claim performance or ergonomics wins must ship with measurements. See [`tea-rags-mcp-70m5`](/roadmap/future-layers#onnx-embedding-performance) for the existing benchmark harness.
4. **Test coverage is a gate, not a goal.** Coverage thresholds stay where they are — new code meets them; old code gets brought up to them when touched.

---

## Related

- [Future Layers](/roadmap/future-layers) — new user-facing capabilities on the roadmap
- [Open Questions](/roadmap/open-questions) — design-level questions not yet resolved
- [Architecture Overview](/architecture/overview) — current structure
