# tea-rags Schema Overview

## Available Resources
- tea-rags://guide/presets — rerank presets reference
- tea-rags://guide/signals — custom weight signals reference (canonical
  catalog of weight keys — read BEFORE building a custom rerank)
- tea-rags://guide/filters — Qdrant filter syntax and examples

## Tools Quick Reference
- search_code — quick semantic lookup, human-readable output
- semantic_search — analytical, structured JSON; signals via rerank or fields
- hybrid_search — semantic + BM25, best for symbol name + context
- rank_chunks — batch analytics by signals (metaOnly default true; offline scoring, not online search)
- find_similar — find code similar to examples; negative-only inputs + strategy="best_score" → anti-pattern detection
- find_symbol — symbol definition by name OR file outline/doc TOC by relativePath (small file → full text; no embedding);
  pass a rerank preset for a single-call diagnostic (definition + rankingOverlay)

## Response shape
Search tools return `results` as a table `{ columns, rows }` from two results on (one
result or none: a plain list of records): one row per result, cell i belongs to columns[i]. A column name is the result path — `payload.symbolId`,
`payload.relativePath`, `rankingOverlay.chunk.bugFixRate.label`; null = absent. Text tools
(graph, review_changes, …) are compact JSON where every array of 2+ records is the same
table. Read "the symbolId of result 3" as column `payload.symbolId` of row 3.
Search rows: `imports` = count (includeImports=true → lists); all-null columns omitted; floats at 2 significant digits.

## Observability hooks
- get_index_status → `infraHealth`: qdrant url/status/optimizer, embedding
  url/reachable, per-trajectory enrichment health. First debug point when search
  fails or looks wrong.
- Any search response may carry `driftWarning`: running build moved past what
  the index was built with (new payload fields, newer grammar / walker for a held
  language). Names the one repair command. Surface to user; do NOT auto-reindex.
- Search naming a rerank preset may return `presetFilterNotice`: preset's DEFAULT
  filter (most: production = no tests/docs/block) narrowed the set unasked. Names
  preset, constrained payload keys, clearing param. Read before concluding the
  corpus lacks the code.
- Every reranked result carries `rankingOverlay` `{preset, file, chunk}` — preset's
  surfaced signals by bare field name, `{value,label}` when labelled, else raw.
  metaOnly keeps it; only place labels live (metaOnly param states the contract).
  Label resolution algorithm: tea-rags://guide/signal-labels.

## Project calibration
`tea-rags://project/<alias>/metrics?language=<lang>&section=labelMap` →
per-language × per-scope (source/test) percentile labelMaps of every signal
(sections: thresholds, labelMap, capability, resolve, registry). Pick filter
thresholds (minCommitCount / minAgeDays) from them — "high" / "legacy" varies per
codebase. `get_index_metrics` stays for raw distributions.

## Guides
- tea-rags://guide/search-examples — search tool routing, use cases, examples
- tea-rags://guide/indexing — indexing options, git metadata guide
- tea-rags://guide/signal-labels — human-readable label mappings for numeric signals

## Param reference
Inline param hints short; full semantics here.

### Addressing (every project-aware tool)
- `project` — which INDEX: registry alias (pulls qdrantUrl / embeddingModel from entry). Pass on every call.
  Alone → tree = the alias's registered checkout (its current state, any branch).
- `path` — which WORKING TREE: your working directory (branch checkout / linked worktree). Pass WITH project;
  required to read a linked worktree or other checkout. Alone → index resolved via same repo.
- `collection` — raw Qdrant name, lowest-level handle; prefer project + path.
- Resolution priority: collection > project > path.
- index_codebase: `project` = registered alias to (re)index; `path` = first-time registration of a NEW root only.

### level (semantic_search, hybrid_search, rank_chunks, find_similar)
- 'chunk' = rank chunks (functions, classes, blocks) — decomposition, hotspots.
- 'file' = rank files as units — tech debt, ownership. Result carries file-level payload only
  (relativePath, language, imports, git.file, codegraph.symbols.file, …): no chunk fields, no content.
  Outline a file via find_symbol(relativePath).
- Unset → preset signalLevel. Explicit value overrides preset.
- Also sets payload scope of level-aware filters. Unset → each filter's own default:
  minAgeDays/maxAgeDays/minCommitCount: chunk; taskId/author/minFanIn/minFanOut: file.
  modifiedAfter/modifiedBefore/recentAuthor/contributor file-level regardless.

### Typed filters
- `author` — blame owner (most live lines, git blame HEAD), exact name. level 'chunk' → owner of chunk's own lines.
- `recentAuthor` — top committer to FILE in git log window (not blame); name OR email. 'What did X work on' → recentAuthor + modifiedAfter.
- `contributor` — any window committer, exact name as git records it. Superset: 'everything X touched' → contributor; 'where X dominates' → recentAuthor.
- `modifiedAfter` / `modifiedBefore` — git.file.lastModifiedAt vs ISO date ('2024-01-01', '2024-01-01T00:00:00Z').
- `minAgeDays` / `maxAgeDays` — age from lastModifiedAt at QUERY time (0 = within a day). Chunk level: chunk with no
  commit in chunk git window (and docs) dropped. level 'file' → file last commit, grouped per file.
  File-level recency at chunk granularity → modifiedAfter.
- `taskId` — JIRA-style (TD-1234; key learned from repo history), GitHub/GitLab issue/PR (#567; remote required), Azure DevOps (AB#890). File: any commit of file; chunk: chunk's own commits.
- `symbolId` — text match: 'Class' → all its methods, 'method' → that method in any class.
- Codegraph filters (`minFanIn`, `minFanOut`, `minPageRank`, `minInstability`, `minTransitiveImpact`,
  `minConnectionCount`, `isHub`, `isLeaf`) exposed only when codegraph enabled.
  fanIn/fanOut: file = importing / imported files; chunk = call sites / outgoing calls.
- `documentation` / `testFile`: only | exclude | include. Omitted → no filter of own, but preset default may exclude.

### filter (raw Qdrant or { presets })
- Raw: must/should/must_not — syntax in tea-rags://guide/filters. Named: `{ presets: "a,b" }`.
- Omitted → rerank preset's default filter applies (most: production = no tests/docs/block).
  Any explicit filter replaces it; `{}` clears it.
- Default skipped automatically when typed params explicitly select what it excludes:
  testFile "only" / "include", documentation "only" / "include", chunkType test/test_setup, language "markdown".
- Default DID apply → response carries presetFilterNotice naming it + how to clear.

### metaOnly
<!-- data:meta-only-contract -->
Default false; rank_chunks default true (analytics — false to include code).

### fields
- Dot-path allow-list applied server-side before serialization — cuts response size.
- Nesting matters: signals under `git.{file,chunk}.*` and `codegraph.symbols.{file,chunk}.*` (tea-rags://guide/signals).
- EXACT: nothing added back, relativePath included. Omitted → full payload.
- metaOnly = different axis (drops body, trims git). Path no result carried → fieldsWarning, not failure.

### find_similar
- positiveCode: any code block; each string = one example, embedded on the fly.
- strategy: best_score (default) scores each candidate vs every example, supports negative-only;
  average_vector averages positives, fastest; sum_scores sums across examples.

### find_symbol
- symbol: Class#method (instance), Class.method (static), fn (top-level), Class → class + members.
  symbol XOR relativePath. pathPattern applies to symbol mode only.

### Codegraph tools
- get_callers includeAmbiguous: ambiguous dispatch sites whose member matches target — call MAY reach
  target among candidateCount candidates; not materialized as edges. Default false.
- find_cycles pathPattern: cycle kept if ≥1 member resolves to matching file → cross-boundary cycles retained.
- trace_path fromPath / toPath: top-level symbols share bare ids; omitted → trace from all, candidates as namesakes.

### Indexing / collections
- index_codebase seedFromWorktree: sibling git worktree of same repo, same model + settings → clone its index,
  embed only differing files. First index only.
- create_collection schema: top level `{ "type": "object", "properties": {...} }`; add_documents validates each
  document's metadata (all-or-nothing per batch), stores schema `default` for absent fields. Omit = free-form.
- create_collection distance: Cosine recommended (all providers); Dot ≡ Cosine on normalized; Euclid rarely for text.

## IMPORTANT: Destructive Tools

**NEVER call without explicit user confirmation:**
- `clear_index` — deletes ALL indexed data for a codebase (chunks, git metadata, snapshots)
- `delete_collection` — permanently deletes a Qdrant collection and all its data
- `delete_documents` — permanently deletes specific documents from a collection

**Irreversible.** Reindexing a large codebase takes minutes; other sessions may
share the index — clearing breaks their search.

**Indexing fails with "Conflict":** another session is indexing. Wait, or restart
the MCP server. Do NOT clear the index to work around it.
