---
paths:
  - "src/core/domains/**/chunker/hooks/**"
  - "src/core/domains/**/rerank/**"
  - "src/core/domains/ingest/pipeline/enrichment/**"
  - "src/core/domains/ingest/sync/**"
---

# Deep Path Navigation

Paths deeper than 3 levels (e.g. `chunker/hooks/`, `rerank/derived-signals/`):

1. **Use `pathPattern` globs instead of navigating the tree manually.** Prefer
   `pathPattern: "**/chunker/hooks/**"` over step-by-step Glob/Read per dir
   level.

2. **Use path shortcuts from CLAUDE.md** to orient fast. Don't re-discover
   already-documented paths.

3. **Use `bd remember`** on non-obvious architectural decisions in deep modules
   (e.g. why hooks split into comment-capture vs class-body-chunker). Prevents
   re-discovery next session.

4. **Useful glob patterns for common deep areas:**
   - `**/chunker/hooks/**` — all language-specific chunking hooks
   - `**/rerank/presets/**` — all rerank presets (git + static + explore)
   - `**/derived-signals/**` — all derived signal implementations
   - `**/enrichment/**` — enrichment pipeline components
   - `**/sync/**` — synchronization strategies
