# Degraded — embedding / infra unavailable

**Prime digest is a point-in-time SNAPSHOT, not live state.** Its
`embedding: unavailable` line reflects infra health at session start, goes stale
the moment ollama returns. NEVER treat stale digest as licence to fall back to
text search for code discovery. Before acting on suspected outage, confirm with
a LIVE `get_index_status` — its `Infrastructure:` footer reports current
`Embedding (ollama): available | unavailable`. Act on the live read, not the
snapshot.

**Even with embedding genuinely down, code-identifier search still works.**
`find_symbol` uses Qdrant text match (zero embedding); `hybrid_search` answers
from its BM25 leg alone — exact-name match (score up to 1.0) — and says so with
a top-level `denseUnavailable: { reason }` (rows ranked lexically, no semantic
ranking). `semantic_search` / `search_code` / `find_similar` with code have no
other leg: they fail FAST with the provider's outage error (no recovery wait).
Down embedding degrades behavioral/semantic recall — does NOT justify text
search for class/method/constant lookups.

Code-identifier lookup (definition, class / method / constant name) →
`find_symbol` / `hybrid_search` BM25 NOW: no stop, no question, no live-status
gate — neither needs embedding. Same for tasks needing no semantic search
(literal TODO/FIXME scan, known file path, exact import string).

Otherwise, if a LIVE `get_index_status` reports embedding error, or any tea-rags
semantic call fails with embedding/connection error — STOP, ask the user (via
`AskUserQuestion`) to start `ollama serve` or repoint `EMBEDDING_URL`, WAIT for
explicit answer. Do NOT silently downgrade to text search / Read for code
discovery — text search loses recall the user didn't agree to trade. See
`rules/references/runtime-introspection.md` for `infraHealth` diagnosis.

**Qdrant down** (`[QDRANT_UNAVAILABLE]`, vector-store connection error) — same
protocol: STOP, `AskUserQuestion` to start Qdrant per the error's `Hint`
(`docker-compose up`), WAIT for the explicit answer, then retry a LIVE
`get_index_status`. Never run the Hint yourself unasked, never index anyway,
never fall back to text search — every tea-rags read needs Qdrant.
