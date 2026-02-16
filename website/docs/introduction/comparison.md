---
title: Comparison
sidebar_position: 5
---

# TeaRAGs vs Alternatives

A detailed comparison of TeaRAGs with other codebase semantic search solutions. This table compares only implemented functionality — no roadmaps or promises. Every cell links to evidence.

**Legend:**
- ✅ — supported and confirmed by code/architecture
- ⚠️ — partial / optional / not core
- ❌ — not supported
- 🧠 — supported through architecture (not a single feature)
- 🚫 — architecturally absent

## At a Glance

| | TeaRAGs | claude-context | serena | rag-code-mcp | DocRAG | grepai |
|---|---|---|---|---|---|---|
| **Purpose** | 🧠 Semantic search for code generation and analysis | [🔍 Semantic code search](https://github.com/zilliztech/claude-context#your-entire-codebase-as-claudes-context) | [🛠 Symbol-level tools via LSP](https://oraios.github.io/serena/01-about/000_intro.html) | [🔍 Local code RAG](https://github.com/doITmagic/rag-code-mcp#-privacy-first-100-local-ai) | [📄 Documentation RAG](https://github.com/ryan-m-bishop/docrag#features) | [🔍 Semantic code search + call graphs](https://github.com/yoanbernabeu/grepai#features) |
| **MCP-native** | ✅ | [✅](https://github.com/zilliztech/claude-context#available-tools) | [✅](https://oraios.github.io/serena/01-about/035_tools.html) | [✅ Go MCP SDK](https://github.com/doITmagic/rag-code-mcp/blob/main/go.mod) | [✅](https://github.com/ryan-m-bishop/docrag#using-with-claude-code) | [✅ mcp-go](https://yoanbernabeu.github.io/grepai/mcp/) |

## Infrastructure

| Criterion | TeaRAGs | claude-context | serena | rag-code-mcp | DocRAG | grepai |
|-----------|---------|---------------|--------|-------------|-------|--------|
| **Local execution** | ✅ Ollama + Qdrant | [⚠️ cloud-first default, local possible](https://github.com/zilliztech/claude-context/issues/162) | [✅ local LSP](https://oraios.github.io/serena/02-usage/020_running.html) | [✅ Ollama + Qdrant](https://github.com/doITmagic/rag-code-mcp/blob/main/config.yaml) | [✅ sentence-transformers + LanceDB](https://github.com/ryan-m-bishop/docrag#architecture) | [✅ 100% local](https://github.com/yoanbernabeu/grepai#why-grepai) |
| **Cloud dependency** | ❌ cloud optional | [⚠️ default, not required](https://github.com/zilliztech/claude-context/issues/162) | [❌](https://oraios.github.io/serena/02-usage/020_running.html) | [❌](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/llm/provider.go) | [⚠️ optional for smart scraping](https://github.com/ryan-m-bishop/docrag#docrag-scrape-url) | [❌ with Ollama](https://yoanbernabeu.github.io/grepai/backends/embedders/) |
| **Embedding model** | ✅ Ollama-first | [⚠️ multi-provider: OpenAI, VoyageAI, Gemini, Ollama](https://deepwiki.com/zilliztech/claude-context/3.2-embedding-providers) | [🚫 not embeddings-based](https://oraios.github.io/serena/01-about/000_intro.html) | [✅ Ollama-only](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/llm/ollama.go) | [⚠️ sentence-transformers family](https://github.com/ryan-m-bishop/docrag#configuration) | [✅ Ollama-first](https://yoanbernabeu.github.io/grepai/backends/embedders/) |
| **GPU path** | 🧠 batching + concurrency | [❌ infra-delegated](https://github.com/zilliztech/claude-context#️-architecture) | [🚫](https://oraios.github.io/serena/02-usage/020_running.html) | [❌ sequential requests](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/ragcode/indexer.go) | [❌](https://github.com/ryan-m-bishop/docrag#technical-stack) | [⚠️ sequential for Ollama, parallel for OpenAI](https://yoanbernabeu.github.io/grepai/backends/embedders/) |

## Search Capabilities

| Criterion | TeaRAGs | claude-context | serena | rag-code-mcp | DocRAG | grepai |
|-----------|---------|---------------|--------|-------------|-------|--------|
| **Semantic code search** | ✅ | [✅ hybrid BM25 + dense](https://deepwiki.com/zilliztech/claude-context) | [✅ LSP-semantic, not NLP-semantic](https://oraios.github.io/serena/01-about/035_tools.html) | [✅ vector + hybrid](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/tools/hybrid_search.go) | [❌ docs only](https://github.com/ryan-m-bishop/docrag#available-tools) | [✅](https://yoanbernabeu.github.io/grepai/search/) |
| **Documentation search** | ✅ Markdown AST | [⚠️ Markdown via AST splitter](https://deepwiki.com/zilliztech/claude-context) | [⚠️ regex across all files](https://oraios.github.io/serena/01-about/020_programming-languages.html) | [⚠️ Markdown-only via search_docs](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/tools/search_docs.go) | [✅ core purpose](https://github.com/ryan-m-bishop/docrag#docrag-search-query) | [⚠️ text chunks, no format awareness](https://yoanbernabeu.github.io/grepai/configuration/) |
| **AST / structural parsing** | ✅ tree-sitter code + markdown | [⚠️ tree-sitter for chunking only](https://deepwiki.com/zilliztech/claude-context) | [🧠 LSP symbol graph](https://deepwiki.com/oraios/serena/5-language-server-protocol-integration) | [⚠️ Go/PHP AST, Python regex](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/ragcode/analyzers/golang/analyzer.go) | [❌ langchain text-splitters](https://github.com/ryan-m-bishop/docrag#core-components) | [⚠️ tree-sitter for call graphs only](https://yoanbernabeu.github.io/grepai/trace/) |
| **Reranking** | 🧠 hybrid (BM25 + RRF + signals) | [🧠 hybrid BM25 + dense with RRF](https://deepwiki.com/zilliztech/claude-context) | [⚠️ implicit LSP ordering](https://oraios.github.io/serena/01-about/035_tools.html) | [⚠️ cosine + hardcoded hybrid weights](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/tools/hybrid_search.go) | [❌ basic vector similarity](https://github.com/ryan-m-bishop/docrag#architecture) | [⚠️ cosine + optional RRF + path boost](https://yoanbernabeu.github.io/grepai/search/) |
| **Git-aware (blame/churn/age)** | ✅ | [❌](https://github.com/zilliztech/claude-context#available-tools) | [⚠️ git diff via shell, not metrics](https://oraios.github.io/serena/02-usage/040_workflow.html) | [❌ planned in roadmap](https://github.com/doITmagic/rag-code-mcp/blob/main/docs/ROADMAP.md) | [❌](https://github.com/ryan-m-bishop/docrag#features) | [❌ gitignore only](https://github.com/yoanbernabeu/grepai/blob/main/CHANGELOG.md) |

## Indexing

| Criterion | TeaRAGs | claude-context | serena | rag-code-mcp | DocRAG | grepai |
|-----------|---------|---------------|--------|-------------|-------|--------|
| **Index as first-class object** | ✅ | [❌](https://github.com/zilliztech/claude-context/issues/245) | [🚫 LSP-based, no persistent index](https://github.com/oraios/serena/issues/372) | [❌ thin wrapper over Qdrant](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/memory/longterm.go) | [❌](https://github.com/ryan-m-bishop/docrag#data-structure) | [⚠️ status tool, no versioning](https://yoanbernabeu.github.io/grepai/configuration/) |
| **Incremental indexing** | ✅ git-delta + fingerprints | [⚠️ Merkle tree, file-level](https://deepwiki.com/zilliztech/claude-context) | [🚫](https://github.com/oraios/serena/issues/890) | [⚠️ file-level via mtime + hash](https://github.com/doITmagic/rag-code-mcp/blob/main/docs/incremental_indexing.md) | [❌ append-only](https://github.com/ryan-m-bishop/docrag#cli-commands) | [⚠️ FS-level, not git-delta](https://github.com/yoanbernabeu/grepai/blob/main/CHANGELOG.md) |
| **Sub-file reindex** | ✅ chunk-level delta | [❌ file-level](https://deepwiki.com/zilliztech/claude-context) | [🚫](https://github.com/oraios/serena/issues/372) | [❌ file-level](https://github.com/doITmagic/rag-code-mcp/blob/main/docs/incremental_indexing.md) | [❌](https://github.com/ryan-m-bishop/docrag#cli-commands) | [❌ full file re-chunk](https://yoanbernabeu.github.io/grepai/configuration/) |
| **Stateful model** | ✅ | [❌](https://github.com/zilliztech/claude-context#available-tools) | [🚫 agent memory exists, not code model](https://oraios.github.io/serena/01-about/035_tools.html) | [❌](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/memory/shortterm.go) | [❌](https://github.com/ryan-m-bishop/docrag#architecture) | [❌](https://yoanbernabeu.github.io/grepai/search/) |

## Scale

| Criterion | TeaRAGs | claude-context | serena | rag-code-mcp | DocRAG | grepai |
|-----------|---------|---------------|--------|-------------|-------|--------|
| **Supported project size** | ✅ 1M–10M+ LOC | [⚠️ claims "millions of lines", no benchmarks](https://github.com/zilliztech/claude-context#-evaluation) | [⚠️ LSP-dependent, issues on large projects](https://github.com/oraios/serena/issues/890) | [⚠️ no benchmarks published](https://github.com/doITmagic/rag-code-mcp#-system-requirements) | [🚫 docs-only](https://github.com/ryan-m-bishop/docrag#features) | [⚠️ benchmarked at 155k LOC](https://yoanbernabeu.github.io/grepai/blog/benchmark-grepai-vs-grep-claude-code/) |
| **Enterprise readiness** | ⚠️ scalable arch, no RBAC/SSO | [❌ no enterprise features](https://github.com/zilliztech/claude-context#available-tools) | [⚠️ Docker, tool restrictions](https://oraios.github.io/serena/02-usage/070_security.html) | [⚠️ privacy yes, features no](https://github.com/doITmagic/rag-code-mcp#-privacy-first-100-local-ai) | [❌](https://github.com/ryan-m-bishop/docrag#features) | [⚠️ multi-workspace, PG backend](https://yoanbernabeu.github.io/grepai/configuration/) |
| **Reindex speed (large repo)** | ✅ seconds–minutes | [⚠️ incremental exists, no benchmarks](https://deepwiki.com/zilliztech/claude-context) | [🚫](https://github.com/oraios/serena/issues/890) | [⚠️ sequential embedding bottleneck](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/ragcode/indexer.go) | [❌](https://github.com/ryan-m-bishop/docrag#cli-commands) | [⚠️ fast FS detection, sequential embedding](https://github.com/yoanbernabeu/grepai/blob/main/CHANGELOG.md) |
| **Local perf strategy** | 🧠 batching + delta + no SaaS | [⚠️ cloud-first default, local possible](https://github.com/zilliztech/claude-context/blob/master/docs/getting-started/environment-variables.md) | [🧠 LSP symbol graph](https://oraios.github.io/serena/01-about/000_intro.html) | [⚠️ local Ollama, sequential](https://github.com/doITmagic/rag-code-mcp/blob/main/internal/llm/ollama.go) | [⚠️ local LanceDB](https://github.com/ryan-m-bishop/docrag#technical-stack) | [⚠️ local store + content dedup](https://github.com/yoanbernabeu/grepai/blob/main/CHANGELOG.md) |

## Summary

TeaRAGs occupies a unique position: it's the only MCP-native solution that combines **semantic search**, **AST-aware chunking**, **git trajectory enrichment**, and **enterprise-scale indexing** in a single local-first package.

The closest functional competitor is **[claude-context](https://github.com/zilliztech/claude-context)** — it shares hybrid BM25+RRF reranking and tree-sitter AST chunking, but lacks git enrichment, sub-file reindexing, and signal-based reranking presets. For pure local code search, **[grepai](https://github.com/yoanbernabeu/grepai)** offers call graph tracing and optional RRF hybrid search, but lacks AST-aware chunking for search and git enrichment. For symbol-level analysis, **[serena](https://github.com/oraios/serena)** takes an LSP-based approach that complements rather than competes with RAG-based search.

---

*Comparison current as of February 2026. Based on publicly available code and documentation. Every cell links to evidence. No dinosaurs were harmed in the making of this table.* 🦖
