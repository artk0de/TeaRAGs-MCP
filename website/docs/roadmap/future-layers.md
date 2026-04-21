---
title: "Future Layers"
sidebar_position: 2
---

# Future Layers

New capabilities on the roadmap that extend TeaRAGs beyond its current retrieval-and-rerank surface. Each is an epic tracked in beads; the issue IDs below are stable references.

This page lists **structural new layers** — not individual tools or presets. For the smaller items, see the beads backlog (`bd list --status=open`).

---

## Codegraph — dependency analysis and graph metrics

**Epic**: `tea-rags-mcp-l26` · P1

Today TeaRAGs stores `imports[]` per chunk (file-level outgoing imports) but doesn't invert that graph. The codegraph layer adds:

- **`importedBy`** (`tea-rags-mcp-74o`) — reverse-dependency tracking. Know which files depend on the current one; blast radius becomes a concrete number, not an intuition.
- **Graph metrics for tech-debt ranking** (`tea-rags-mcp-0li` research) — centrality (betweenness, PageRank), coupling (afferent/efferent per Robert Martin), cycle detection.
- **Complexity metrics from AST** (`tea-rags-mcp-nyg`) — cyclomatic + cognitive complexity as additional payload signals.
- **`find_symbol` graph extensions** (`tea-rags-mcp-zvyc`, `tea-rags-mcp-09fu`) — class outline improvements that unblock graph-based navigation.

**Where it lands:** as a new enrichment provider alongside `static` and `git`. Same architecture as documented in [Custom Enrichments](/extending/custom-enrichments); payloads become `deps.file.importedByCount`, `deps.file.fanOut`, `deps.file.isHub`, etc.

**Why it matters:** enables a proper `blastRadius` rerank preset and replaces the currently-imperfect `imports` weight (which only captures fan-out). See [Code Quality Metrics](/knowledge-base/code-quality-metrics#6-proposed-reranker-signals) for the theoretical grounding.

---

## EggVolution — self-evolving associative memory

**Epic**: `tea-rags-mcp-e98j` · P1 (blocked on Codegraph)

A second collection alongside the code index that stores **atomic knowledge units** ("eggs") about the codebase — failure modes, decisions, anti-patterns — with a lifecycle that learns from real diffs.

The proposal draws from two recent papers:

- **Context7 / Codified Context Infrastructure** (arXiv:2602.20478) — two-tier architecture: static apex governance (CLAUDE.md, rules, skills) + dynamic nest (Qdrant collection with lifecycle).
- **ACE / Agentic Context Engineering** (arXiv:2510.04618) — viable/sterile counters, delta updates, semantic dedup ("candling").

Core lifecycle:

```
Code change (diff)
  → Laying: detect knowledge gap via cosine(diff, eggs)
  → Ovulation: Llama captions the gap → new egg
  → Candling: embed + dedup against existing eggs
  → Imprinting: resolved_symbols attach egg to code via vector proximity
  → Retrieval: natural selection — viable eggs rank higher
  → Candling (on new diff): cosine → viable++ or sterile++
  → Brooding: fossilise sterile eggs, detect abandoned nests
  → Hatching: viable clusters → best-practice rules (dominant species)
  → Hatching: sterile clusters → anti-pattern warnings (extinction events)
  → Ice age: unused eggs frozen, eventually deleted
```

Three species with distinct lifecycle rules:

| Species | Source | Fossilisation rule |
|---------|--------|-------------------|
| Auto | Diff-gap detection via Llama captioning | `sterile > viable*2` → fossil |
| Human | Explicit user contribution | Never auto-fossil (apex-predator domain) |
| Petrified | AST-linked code comments (`HACK`, `WARN`, `WHY`, `NOTE`) | Auto-update on chunk reprocess |

**Why it matters:** code alone doesn't answer "why does this have a 30s timeout?" — the answer lives in Slack threads, Jira tickets, and the head of whoever wrote it. EggVolution makes that knowledge grep-able and enriches retrieval with business context.

**Status:** design complete, children enumerated (typed collections, clutch bootstrap, petrified eggs, imprinting, laying, candling, brooding, hatching). Implementation blocked on codegraph — imprinting needs symbol-level resolution that graph metrics unlock.

---

## Advanced search features

**Epic**: `tea-rags-mcp-iw4m` · P3

A cluster of retrieval capabilities that Qdrant's recent versions unlock:

### MMR and multi-preset reranking

- **MMR diversity reranking** (`tea-rags-mcp-0xva`) — server-side Maximal Marginal Relevance via Qdrant 1.15. Diverse top-K instead of near-duplicates.
- **Multi-preset rank with overlap detection** (`tea-rags-mcp-c0su`) — run multiple rerank presets server-side, report which results appear in several (high-confidence) vs one only (preset-specific).

### Filter quality

- **ACORN 2-hop HNSW traversal** (`tea-rags-mcp-g3lm`) — better recall when post-filter removes many candidates.
- **Text index with stemming + phrase matching** (`tea-rags-mcp-z3a9`) — closer to real BM25 semantics on payload fields.

### New search dimensions

- **Git history semantic search** (`tea-rags-mcp-8xbc`) — index commit messages + diffs as chunks, answer "when was X introduced" semantically.
- **Federated multi-collection search** (`tea-rags-mcp-a9b3`) — one query across several indexed codebases (useful for monorepo + vendored deps scenarios).
- **Contextual search tool** (`tea-rags-mcp-n5fz`) — pass a symbol/chunk as context, retrieve related code without writing an explicit query.

---

## ONNX embedding performance

**Epic**: `tea-rags-mcp-70m5` · P3

Capacity improvements for the default local embedding provider:

- **Benchmark harness** (`tea-rags-mcp-3ww`) — `npm tune` / `npm embedding-benchmark` for regression tracking on model + hardware combinations.
- **Multi-model daemon** (`tea-rags-mcp-4mu`) — support multiple ONNX models in a single daemon process, useful for ensembles or A/B testing.
- Already landed: in-process zero-overhead daemon (`tea-rags-mcp-eg0`), general inference optimisation (`tea-rags-mcp-92i`).

Tied to the [adaptive GPU batching](/config/providers/onnx#tuning-notes) already in place; the benchmark harness turns intuitive tuning into measurable tuning.

---

## Related

- [Architecture Evolution](/roadmap/architecture-evolution) — refactorings that don't add capabilities
- [Open Questions](/roadmap/open-questions) — directions not yet decided
- [Custom Enrichments](/extending/custom-enrichments) — how new layers plug in structurally
