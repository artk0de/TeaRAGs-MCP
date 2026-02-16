<p align="center">
  <img src="public/logo.png" width="200">
</p>

<h1 align="center">TeaRAGs</h1>

<p align="center">
  <strong>Trajectory Enrichment-Aware RAG for Coding Agents</strong>
</p>

![MCP compatible](https://img.shields.io/badge/MCP-compatible-%234f46e5)
[![quickstart < 5 min](https://img.shields.io/badge/quickstart-%3C%2015%20min-f59e0b)](#quick-start)
[![local-first](https://img.shields.io/badge/deployment-local--first-15803d)](#installation)
[![reproducible: docker](https://img.shields.io/badge/reproducible-docker-0f172a)](#installation)
[![provider agnostic](https://img.shields.io/badge/provider-agnostic-0891b2)](#prov)
![embeddings](https://img.shields.io/badge/embeddings-supported-%230d9488)
![reranking](https://img.shields.io/badge/retrieval-reranking-%2303734f)

[![CI](https://github.com/artk0de/TeaRAGs-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/artk0de/TeaRAGs-MCP/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/artk0de/TeaRAGs-MCP/graph/badge.svg?token=BU255N03YF)](https://codecov.io/gh/artk0de/TeaRAGs-MCP)

---

> **Built on a fork of
> [mcp-server-qdrant](https://github.com/mhalder/qdrant-mcp-server)**

A high-performance **trajectory enrichment-aware** code **RAG system** exposed as an **MCP**
server. Built for large monorepos and actively growing codebases in
enterprise/team environments. Combines semantic retrieval with development
history signals — authorship, churn patterns, change volatility, bug-fix rates —
to rerank results beyond pure similarity. AST-aware chunking, incremental
indexing, handles millions of LOC. Topological layer (symbol graphs, coupling
analysis) planned. Built on Qdrant. Works with Ollama (local, private) or cloud
providers (OpenAI, Cohere, Voyage).

> **[Check out our awesome wiki](https://artk0de.github.io/TeaRAGs-MCP/)** — full documentation, 15-minute quickstart, agent workflow guides, and architecture deep dives.

## What Is Trajectory Enrichment?

Standard code RAG embeds source code and retrieves by similarity alone. **Trajectory enrichment** augments each chunk with signals about how code evolves and how it connects — at the **function/method level**, not just the file level.

TeaRAGs implements two enrichment layers:

- **Git trajectory** (implemented) — churn, authorship, volatility, bug-fix rates, task traceability. **19 scoring signals** feed a reranking layer with composable presets (`hotspots`, `ownership`, `techDebt`, `securityAudit`, etc.)
- **Topological trajectory** (planned) — symbol dependency graphs, cross-file coupling, blast radius analysis. Enables queries like "find high-impact code with many dependents"

The git trajectory layer is **opt-in** (`CODE_ENABLE_GIT_METADATA=true`). Without it, the system operates as standard semantic code search with AST-aware chunking and hybrid retrieval.

### Agentic Data-Driven Engineering

Trajectory enrichment opens the path to **agentic data-driven engineering** — where AI agents make code generation decisions backed by empirical evidence, not pattern matching intuition.

Instead of "find similar code and copy it", an agent can:

1. **Find stable templates** (`rerank: "stable"`) — 0% bug rate, low churn, battle-tested
2. **Avoid anti-patterns** (`rerank: "hotspots"`) — high bug-fix rate, volatile code
3. **Match domain owner's style** (`rerank: "ownership"`) — consistent with existing conventions
4. **Understand feature context** via `taskIds` — why the code exists, not just what it does
5. **Assess modification risk** (`rerank: "techDebt"`) — apply defensive patterns for legacy code

> *"This transforms code generation from artistic guesswork into data-driven engineering."*

👉 **[Full explanation in the docs](https://artk0de.github.io/TeaRAGs-MCP/introduction/core-concepts)** · **[Agentic Data-Driven Engineering](https://artk0de.github.io/TeaRAGs-MCP/advanced/agentic-data-driven-engineering)**

## Quick Start

```bash
git clone https://github.com/mhalder/qdrant-mcp-server.git
cd qdrant-mcp-server
npm install && npm run build

# Start Qdrant + Ollama
podman compose up -d
podman exec ollama ollama pull unclemusclez/jina-embeddings-v2-base-code:latest

# Add to Claude Code
claude mcp add tea-rags -s user -- node /path/to/tea-rags-mcp/build/index.js \
  -e QDRANT_URL=http://localhost:6333 \
  -e EMBEDDING_BASE_URL=http://localhost:11434
```

Then ask your agent: *"Index this codebase for semantic search"*

## Documentation

Full documentation: **[artk0de.github.io/TeaRAGs-MCP](https://artk0de.github.io/TeaRAGs-MCP/)**

| Section | Description |
|---------|-------------|
| [Introduction](https://artk0de.github.io/TeaRAGs-MCP/introduction/what-is-tearags) | What TeaRAGs is, core concepts, trajectory enrichment |
| [Quickstart](https://artk0de.github.io/TeaRAGs-MCP/quickstart/installation) | Installation, setup, first index and query |
| [Configuration](https://artk0de.github.io/TeaRAGs-MCP/usage/configuration) | Environment variables, providers, tuning |
| [Tools Schema](https://artk0de.github.io/TeaRAGs-MCP/api/tools) | MCP tools, search parameters, reranking presets |
| [Architecture](https://artk0de.github.io/TeaRAGs-MCP/architecture/overview) | System design, pipeline stages, data model |
| [Operations](https://artk0de.github.io/TeaRAGs-MCP/operations/troubleshooting) | Troubleshooting, FAQ, recovery |

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for workflow and conventions.

## Branding

TeaRAGs name and logo are covered by the brand policy. See [BRAND.md](BRAND.md).

## Acknowledgments

The author of Tea Rags MCP proudly continues the noble tradition of forking. 🍴

Huge thanks to
**[mhalder/qdrant-mcp-server](https://github.com/mhalder/qdrant-mcp-server)** —
this fork wouldn't exist without your solid foundation:

- 💎 Clean and extensible architecture
- 📚 Excellent documentation and examples
- 🧪 Solid test coverage
- 🤝 Open-source spirit and MIT license

And in the spirit of paying it forward, we also thank the ancestor of all forks
— **[qdrant/mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant)**.
The circle of open source is complete. 🙏

The code vectorization feature is inspired by concepts from the excellent
**[claude-context](https://github.com/zilliztech/claude-context)** project (MIT
License, Zilliz).

_Feel free to fork this fork. It's forks all the way down._ 🐢

## License

MIT — see [LICENSE](LICENSE).
