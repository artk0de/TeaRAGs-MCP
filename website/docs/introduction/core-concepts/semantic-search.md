---
title: Semantic Search
sidebar_position: 3
---

import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

Semantic search is the foundation of TeaRAGs. It enables finding code and
documentation by **intent and meaning**, not by exact keyword matching. You can
ask "how does authentication work?" and get the actual implementation, even if
it's called `Pipeline::StageClient` or `InfoRequest`.

## How It Works

Traditional text search (grep, ripgrep) requires you to know exact identifiers,
function names, or keywords. If the code uses a different naming convention or
synonym, you miss it entirely.

**Semantic search** converts both your query and the code into **vector
embeddings** — mathematical representations that capture meaning. Code chunks
with similar **meaning** to your query are ranked by cosine similarity,
regardless of exact wording.

### The Pipeline

<MermaidTeaRAGs>
{`
flowchart LR
    query["🔍 Query<br/><small>'authentication flow'</small>"]
    embed_q["✨ Embedding Model"]
    vec_q["📐 Query Vector<br/><small>[0.23, -0.41, 0.18, ...]</small>"]

    code["📁 Code Chunk<br/><small>function validateToken(...)</small>"]
    embed_c["✨ Embedding Model"]
    vec_c["📐 Code Vector<br/><small>[0.25, -0.39, 0.17, ...]</small>"]

    similarity["🎯 Cosine Similarity<br/><small>0.94 (high match)</small>"]

    query --> embed_q --> vec_q
    code --> embed_c --> vec_c

    vec_q --> similarity
    vec_c --> similarity

`} </MermaidTeaRAGs>

1. **At index time**: Each code chunk is converted to a dense vector (768–3072
   dimensions) via an embedding model
2. **At search time**: Your natural language query is converted to a vector
   using the same model
3. **Ranking**: Qdrant finds chunks with the highest cosine similarity to your
   query vector
4. **Results**: Top-ranked chunks are returned with their similarity scores

## When to Use Semantic Search

Semantic search shines when:

- **Exploring unfamiliar codebases** — "how does caching work here?"
- **Searching by intent, not name** — "retry logic with exponential backoff"
- **Cross-language discovery** — "database connection pooling" finds patterns in
  Go, Python, TypeScript
- **Synonym matching** — "authorization" also finds "access control",
  "permissions"
- **Documentation search** — natural language queries across README, docs,
  comments

## Embedding Models

TeaRAGs supports multiple embedding providers. The choice affects search
quality, speed, and privacy:

| Provider   | Model (default)                             | Dimensions | Privacy        | Speed  |
| ---------- | ------------------------------------------- | ---------- | -------------- | ------ |
| **Ollama** | `unclemusclez/jina-embeddings-v2-base-code` | 768        | 🔒 Local-first | Medium |
| OpenAI     | `text-embedding-3-small`                    | 1536       | ☁️ Cloud API   | Fast   |
| Cohere     | `embed-english-v3.0`                        | 1024       | ☁️ Cloud API   | Fast   |
| Voyage     | `voyage-code-2`                             | 1024       | ☁️ Cloud API   | Fast   |

**Recommended**: For code search, use **Jina Code Embeddings**
(`unclemusclez/jina-embeddings-v2-base-code`) — trained specifically on source
code, supports 30+ programming languages, runs locally with Ollama.

## Semantic Search vs Grep

| Aspect                  | Grep / Ripgrep                             | Semantic Search                                          |
| ----------------------- | ------------------------------------------ | -------------------------------------------------------- |
| **Query style**         | Exact string or regex                      | Natural language                                         |
| **Match type**          | Literal text match                         | Meaning-based similarity                                 |
| **Synonym handling**    | ❌ Must list all variants                  | ✅ Understands "auth", "authentication", "authorization" |
| **Cross-language**      | ❌ Must know syntax per language           | ✅ Finds patterns across Python, Go, TypeScript          |
| **Unfamiliar codebase** | ❌ Requires knowing what to search for     | ✅ Describe what you need, get relevant code             |
| **Exact identifiers**   | ✅ Perfect for function names, error codes | ⚠️ May miss exact matches (use hybrid search)            |
| **Performance**         | Instant (scans raw text)                   | Near-instant after indexing (vector similarity)          |
| **Setup**               | None                                       | Requires indexing (one-time cost)                        |

**When to use grep**: Known exact identifier, error message, config key, TODO
comment. **When to use semantic search**: Exploring by concept, intent,
behavior, patterns.

## Semantic Search Modes in TeaRAGs

TeaRAGs provides two tools for semantic search:

### 1. `search_code` (Recommended for Development)

Practical tool with sensible defaults and shorthand filters:

```bash
# Basic search
/mcp__tea-rags__search_code /path/to/project "authentication middleware"

# Filter by file type
/mcp__tea-rags__search_code /path "error handling" --fileTypes .ts,.tsx

# Filter by path pattern
/mcp__tea-rags__search_code /path "validation" --pathPattern src/api/**

# Filter by git metadata (requires TRAJECTORY_GIT_ENABLED=true)
/mcp__tea-rags__search_code /path "recent changes" --author alice@example.com

# Documentation only
/mcp__tea-rags__search_code /path "setup guide" --documentationOnly true

# Rerank for stable code
/mcp__tea-rags__search_code /path "database pool" --rerank stable
```

### 2. `semantic_search` (Advanced Analytics)

Full-featured tool with native Qdrant filters and metadata-only mode:

```json
{
  "collection": "code_a3f8d2e1",
  "query": "authentication middleware",
  "limit": 20,
  "filter": {
    "must": [
      { "key": "language", "match": { "value": "typescript" } },
      { "key": "git.commitCount", "range": { "gte": 3 } }
    ]
  },
  "rerank": "ownership",
  "metaOnly": true
}
```

Use `semantic_search` when you need:

- Complex boolean filters (`must`, `should`, `must_not`)
- Metadata-only responses (file discovery without code content)
- Analytical queries with rerank presets (`techDebt`, `hotspots`,
  `securityAudit`)

## Example: Finding Authentication Code

**Query**: `"How does user authentication work in this codebase?"`

**What happens**:

1. Query is embedded → `[0.23, -0.41, 0.18, ...]` (768-dim vector)
2. Qdrant searches for chunks with high cosine similarity
3. Results ranked by semantic relevance:

```
1. src/auth/middleware.ts:15-42 (score: 0.91)
   export function authenticateRequest(req: Request) {
     const token = extractBearerToken(req.headers);
     return verifyJWT(token, config.secret);
   }

2. src/auth/jwt.ts:8-29 (score: 0.87)
   function verifyJWT(token: string, secret: string) {
     try {
       return jwt.verify(token, secret);
     } catch (err) {
       throw new UnauthorizedError("Invalid token");
     }
   }

3. docs/authentication.md:1-45 (score: 0.82)
   # Authentication Flow
   The system uses JWT-based authentication...
```

Notice:

- Found `authenticateRequest`, `verifyJWT`, and related documentation
- No exact match on "authentication" keyword in function names
- Cross-file discovery (middleware + JWT logic + docs)
- Ranked by semantic relevance

## Semantic Search is NOT a Grep Replacement {#not-grep-replacement}

:::warning[Critical: Semantic search requires verification]

Semantic search is a **candidate selection tool**, not a grep replacement. AI
agents must follow this two-step workflow:

1. **Semantic search** — quickly find relevant code locations (broad recall)
2. **Grep verification** — confirm exact identifiers, API calls, imports
   (precision)

**Why this matters**: Semantic search ranks by _meaning similarity_, not exact
matches. A chunk about "user authentication" scores high even if it doesn't
contain the exact function name `authenticateUser()`. Before modifying code or
making claims about what exists in the codebase, **always verify with grep**.

:::

### Best Practice Workflow

<MermaidTeaRAGs>
{`
flowchart TB
    query["🤖 Agent needs to find<br/><small>'authentication logic'</small>"]
    semantic["🔍 Semantic Search<br/><small>returns 5-10 candidates</small>"]
    read["📁 Read candidate files"]
    grep["🔎 Grep verification<br/><small>'function authenticate'<br/>'import.*auth'</small>"]
    decision{"🎯 Exact match<br/>found?"}
    proceed["✅ Proceed with<br/><small>confidence</small>"]
    expand["🔄 Expand search or<br/><small>ask user</small>"]

    query --> semantic --> read --> grep --> decision
    decision -->|Yes| proceed
    decision -->|No| expand

`} </MermaidTeaRAGs>

**Example failure mode without verification:**

```
Agent: "I'll use the authenticateUser function from src/auth/middleware.ts"
Reality: The file contains authentication *concepts* but the actual function is named validateCredentials()
Result: Agent generates code with non-existent function reference → compilation error
```

**Correct workflow:**

```
1. Semantic search: "authentication logic"
   → Returns src/auth/middleware.ts (high similarity)

2. Read candidate: src/auth/middleware.ts
   → Contains authentication-related code

3. Grep verification: grep -r "function authenticate" src/
   → Found: src/auth/middleware.ts:15: function validateCredentials(...)
   → Found: src/utils/jwt.ts:8: function authenticateToken(...)

4. Agent uses actual function names: validateCredentials(), authenticateToken()
```

### When to Use Each Tool

| Task                                      | Tool            | Reason                        |
| ----------------------------------------- | --------------- | ----------------------------- |
| "Find authentication-related code"        | Semantic search | Broad concept discovery       |
| "Does function `authenticateUser` exist?" | Grep            | Exact identifier verification |
| "Where is JWT validation implemented?"    | Semantic search | Intent-based discovery        |
| "Find all calls to `verifyToken()`"       | Grep            | Exact API usage analysis      |
| "How do we handle payment errors?"        | Semantic search | Concept exploration           |
| "Does this import `stripe` package?"      | Grep            | Exact dependency check        |

### Why Verification Matters

Semantic embeddings capture _meaning_, not _literals_:

- `"user authentication"` → high similarity to chunks about login, sessions,
  tokens, access control
- But doesn't guarantee presence of exact strings like `authenticateUser`,
  `loginUser`, `verifySession`
- Embedding models understand synonyms and context, which is powerful for
  discovery but risky for precision

**Rule of thumb**: Use semantic search to _find where to look_, then use grep to
_confirm what's actually there_.

## Limitations

Semantic search is not perfect:

1. **Exact identifiers**: May miss exact function names like `getUserById` when
   searching for "user retrieval" — use **hybrid search** to combine semantic +
   keyword matching, and **always verify with grep** before using identifiers
2. **Rare terms**: Uncommon acronyms or project-specific jargon may not embed
   well — again, hybrid search helps
3. **Indexing required**: First-time indexing takes time (see
   [benchmarks](/introduction/what-is-tearags#agent-on-grep-vs-agent-on-semantic-search))
   — but incremental updates are fast
4. **Embedding quality**: Search quality depends on the embedding model — use
   code-specialized models like Jina Code for best results
5. **False positives**: High-scoring results may discuss a concept without
   implementing it — verification step is critical

## Next Steps

- [Hybrid Search](/usage/advanced/query-modes#hybrid-search) — combine semantic + keyword
  matching
- [Trajectory Enrichment Awareness](./tea) — enrich results with git-derived
  quality signals
- [Reranking](./reranking) — reorder results by stability, ownership, tech debt
