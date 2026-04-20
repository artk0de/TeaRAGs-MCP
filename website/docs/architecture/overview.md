---
title: Overview
sidebar_position: 1
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

TeaRAGs is an MCP server that orchestrates code vectorization, trajectory enrichment, and quality-aware retrieval. It sits between the AI agent and the vector database, managing the complexity of embedding, git metadata extraction, and reranking.

## System Architecture

<MermaidTeaRAGs>
{`

flowchart TB
    A["🤖 AI Agent"]
    T["🍵 TeaRAGs MCP Server"]
    Q[("🗄️ Qdrant")]
    E["🧮 Embedding Service"]
    D["📁 Codebase + Git"]

    A <-->|"MCP (stdio / HTTP)"| T
    T <-->|vectors + search| Q
    T <-->|embed batches| E
    D -->|"scan + git log/blame"| T

`}
</MermaidTeaRAGs>

## Component Layers

### 1. Agent Layer

<MermaidTeaRAGs>
{`

flowchart LR
    subgraph agents["Supported Agents"]
        direction TB
        CC["Claude Code"]
        RO["Roo"]
        CU["Cursor"]
        ANY["Custom Agent"]
    end

    subgraph proto["MCP Protocol"]
        STDIO["stdio"]
        HTTP["HTTP"]
    end

    TR["🍵 TeaRAGs"]

    CC & RO & CU & ANY --> STDIO & HTTP --> TR

`}
</MermaidTeaRAGs>

The **AI agent** (Claude Code, Roo, Cursor, or custom) orchestrates the overall workflow:
- Decides when to search code
- Formulates natural language queries
- Interprets search results
- **Verifies findings with grep** (best practice)
- Makes code generation decisions

The agent communicates with TeaRAGs via the **MCP protocol** (stdio or HTTP transport).

### 2. TeaRAGs MCP Server (Orchestration Engine)

<MermaidTeaRAGs>
{`

flowchart TB
    TH["MCP Tools Handler<br/>index · search · reindex"]

    subgraph indexing["Indexing Path"]
        direction LR
        CI["Code Indexer<br/>AST · Chunker"]
        EP["Embedding Pipeline<br/>Batch · Concurrency"]
        CI --> EP
    end

    subgraph search["Search Path"]
        direction LR
        SE["Search Engine<br/>Query · Filter"]
        RR["Reranker<br/>20+ signals"]
        SE --> RR
    end

    GE["Git Enricher<br/>Blame · Log"]

    TH --> indexing
    TH --> search
    EP -.->|"upsert vectors"| SE
    GE -.->|"trajectory signals"| RR

`}
</MermaidTeaRAGs>

TeaRAGs is the central orchestrator with six internal subsystems:

| Component | Responsibility | Key Details |
|-----------|---------------|-------------|
| **Code Indexer** | Scans codebase, performs AST-aware chunking via tree-sitter | Respects `.gitignore` / `.contextignore`. Handles incremental updates (added/modified/deleted files) |
| **Git Enricher** | Extracts metadata from `git log` and `git blame` | Computes 23 raw signals (13 file + 10 chunk) + 14 derived signals: churn, volatility, authorship, bug-fix rates, task IDs. File-level and chunk-level granularity |
| **Search Engine** | Converts queries to vectors, applies filters, executes search | Qdrant filters (language, path, git metadata). Semantic search and hybrid search (BM25 + RRF) |
| **Reranker** | Re-scores results using trajectory signals | Composable presets: `hotspots`, `ownership`, `techDebt`, `stable`, etc. Custom weight configs supported |
| **Embedding Pipeline** | Batches chunks for efficient embedding generation | Manages concurrency, retry logic, backpressure. Supports Ollama, OpenAI, Cohere, Voyage AI |
| **MCP Tools Handler** | Exposes MCP tools, handles invocation and validation | Tools: `index_codebase`, `search_code`, `semantic_search`, `reindex_changes` |

### 3. External Services

<MermaidTeaRAGs>
{`

flowchart LR
    TR["🍵 TeaRAGs"]

    subgraph qdrant["Qdrant Vector DB"]
        direction TB
        DV["Dense Vectors<br/>768–3072 dim"]
        SV["Sparse Vectors<br/>BM25"]
        PL["Payload<br/>20+ git signals + metadata"]
    end

    subgraph embed["Embedding Service"]
        direction TB
        OL["Ollama<br/>jina-embeddings-v2"]
        OA["OpenAI<br/>text-embedding-3"]
        CO["Cohere<br/>embed-english-v3.0"]
        VA["Voyage AI<br/>voyage-code-2"]
    end

    TR <-->|"upsert · search"| qdrant
    TR <-->|"embed batches"| embed

`}
</MermaidTeaRAGs>

| Service | Role | Details |
|---------|------|---------|
| **Qdrant** | Vector database | Dense vectors (768–3072 dim), sparse vectors (BM25 for hybrid search), payload (23 raw git signals — 13 file + 10 chunk — plus static structural signals and file metadata). Cosine similarity search at scale |
| **Embedding Service** | Text → vector conversion | **Ollama** (local, recommended: `jina-embeddings-v2-base-code`), **OpenAI** (`text-embedding-3-small/large`), **Cohere** (`embed-english-v3.0`), **Voyage AI** (`voyage-code-2`) |

### 4. Data Sources

<MermaidTeaRAGs>
{`

flowchart LR
    subgraph sources["Data Sources"]
        direction TB
        CB["📄 Codebase<br/>TS · Python · Go · Ruby · Markdown"]
        GR["📜 Git Repository<br/>Commits · Authors · Task IDs"]
        CS["💾 Cache<br/>~/.tea-rags/"]
    end

    TR["🍵 TeaRAGs"]

    CB -->|"scan files"| TR
    GR -->|"git log · git blame"| TR
    CS <-->|"snapshots · git cache · logs"| TR

`}
</MermaidTeaRAGs>

| Source | Purpose | Details |
|--------|---------|---------|
| **Codebase** | Source files and documentation | TypeScript, Python, Go, Ruby, Markdown, README. Respects `.gitignore` exclusion rules |
| **Git Repository** | History for trajectory enrichment | Commit history, author metadata, timestamps. Task IDs from commit messages (JIRA, GitHub, Linear) |
| **Cache Storage** (`~/.tea-rags/`) | Incremental indexing and performance | **Snapshots** — file hash snapshots. **Git cache** — L1 (memory) + L2 (disk) for git blame. **Logs** — debug logs (`DEBUG=1`) |

## Request Flow

A typical search request flows through six steps:

### 1. Agent Invocation
```bash
Agent: search_code "authentication logic" --rerank stable
```

### 2. Query Embedding
TeaRAGs sends the query to the Embedding Service:
```
"authentication logic" → [0.23, -0.41, 0.18, ...]
```

### 3. Vector Search
TeaRAGs queries Qdrant with:
- Query vector
- Optional filters (language, path, author, etc.)
- Limit (default: 50 candidates)

### 4. Semantic Ranking
Qdrant returns top 50 chunks ranked by **cosine similarity**:
```json
[
  {"path": "src/auth/middleware.ts", "score": 0.91, "git": {...}},
  {"path": "src/auth/jwt.ts", "score": 0.87, "git": {...}},
  ...
]
```

### 5. Trajectory Reranking
TeaRAGs re-scores results using git signals and the `stable` preset:
- Boosts low-churn, low-bugfix code
- Penalizes high-volatility code
- Returns top 5 chunks

### 6. Agent Decision
Agent receives enriched results:
- Reads candidate files
- **Verifies with grep** (e.g., `grep "function authenticate"`)
- Uses actual identifiers in generated code

## Key Principles

### TeaRAGs as Orchestrator

TeaRAGs does **not** replace the agent's decision-making. It provides:
- **High-recall candidate selection** (semantic search finds relevant code)
- **Quality signals** (trajectory enrichment quantifies stability, ownership, risk)
- **Structured results** (file paths, line numbers, metadata)

The agent still:
- **Decides** which code to use
- **Verifies** exact identifiers with grep
- **Generates** final code

### Separation of Concerns

| Component | Responsibility |
|-----------|----------------|
| **Agent** | Workflow orchestration, decision-making, verification |
| **TeaRAGs** | Indexing, embedding, enrichment, reranking |
| **Qdrant** | Vector storage, similarity search |
| **Embedding Service** | Text → vector conversion |
| **Git** | Source of truth for code history |

### Data Flow Direction

```
Indexing:  Codebase + Git → TeaRAGs → Embedding Service → Qdrant
Searching: Agent → TeaRAGs → Qdrant (retrieve) → TeaRAGs (rerank) → Agent
```

## Performance Characteristics

- **Indexing**: Millions of LOC in minutes (see [benchmarks](/introduction/what-is-tearags#agent-on-grep-vs-agent-on-semantic-search))
- **Search**: Near-instant (&lt;1s for most queries)
- **Incremental updates**: Only changed files re-indexed
- **Concurrency**: Configurable batch sizes, parallel workers
- **Caching**: Git metadata cached, embedding pipeline batched

## Next Steps

- [Indexing Pipeline](./indexing-pipeline) — chunk → embed → upsert flow + incremental reindex
- [Data Model](./data-model) — full payload catalog: base fields + `git.file.*` + `git.chunk.*` + schema versioning
- [Git Enrichment Pipeline](./git-enrichment-pipeline) — how `git.*` signals are computed (2-phase)
- [Cache Lifecycle](./cache-lifecycle) — all caches in the system (Qdrant daemon, stats, git, ONNX, snapshots)
