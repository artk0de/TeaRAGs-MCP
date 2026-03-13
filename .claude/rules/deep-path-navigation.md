# Deep Path Navigation

When working with paths deeper than 3 levels (e.g., `chunker/hooks/`,
`rerank/derived-signals/`):

1. **Use `pathPattern` globs instead of navigating the tree manually.** Prefer
   `pathPattern: "**/chunker/hooks/**"` over step-by-step Glob/Read through each
   directory level.

2. **Use path shortcuts from CLAUDE.md** to orient quickly. Don't re-discover
   paths that are already documented.

3. **Use `bd remember`** when you discover non-obvious architectural decisions
   in deep modules (e.g., why hooks are split into comment-capture vs
   class-body-chunker). This prevents re-discovery in future sessions.

4. **Useful glob patterns for common deep areas:**
   - `**/chunker/hooks/**` — all language-specific chunking hooks
   - `**/rerank/presets/**` — all rerank presets (git + static + explore)
   - `**/derived-signals/**` — all derived signal implementations
   - `**/enrichment/**` — enrichment pipeline components
   - `**/sync/**` — synchronization strategies
