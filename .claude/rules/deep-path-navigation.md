---
paths:
  - "src/core/domains/language/*/chunking/**"
  - "src/core/domains/**/rerank/**"
  - "src/core/domains/ingest/pipeline/enrichment/**"
  - "src/core/domains/ingest/sync/**"
---

# Deep Path Navigation

Paths deeper than 3 levels (e.g. `language/<lang>/chunking/`,
`rerank/derived-signals/`):

1. **Use `pathPattern` globs instead of navigating the tree manually.** Prefer
   `pathPattern: "**/language/*/chunking/**"` over step-by-step Glob/Read per
   dir level.

2. **Use path shortcuts from CLAUDE.md** to orient fast. Don't re-discover
   already-documented paths.

3. **Use `bd remember`** on non-obvious architectural decisions in deep modules
   (e.g. why hooks split into comment-capture vs class-body-chunker). Prevents
   re-discovery next session.

4. **Useful glob patterns for common deep areas:**
   - `**/language/*/chunking/**` — all language-specific chunking hooks
   - `**/rerank/presets/**` — provider presets (git + static + codegraph);
     composites live in `trajectory/composite/presets/`, and
     `explore/rerank/presets/` holds only the resolver
   - `**/derived-signals/**` — all derived signal implementations
   - `**/enrichment/**` — enrichment pipeline components
   - `**/sync/**` — synchronization strategies
