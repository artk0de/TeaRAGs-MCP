# dinopowers Index Freshness Protocol

Wrappers that call tea-rags search (`semantic_search`, `hybrid_search`,
`find_symbol`, `find_similar`, `rank_chunks`) depend on the index being
up-to-date. **If files were created or modified during this session and not yet
reindexed, those files are INVISIBLE to tea-rags** — search returns stale
results and the wrapper degrades to a no-enrichment passthrough that adds no
measurable value over the direct `superpowers:*` skill.

## Required check (MUST run BEFORE the first tea-rags call in any wrapper)

1. Determine if any file has been edited in this session via `Edit` / `Write` /
   `MultiEdit` (or by a subagent).
   - If your session has made **zero** file edits since session start → skip
     this protocol, proceed to Step 1 of the wrapper.
   - If **any** file was edited → continue.

2. Call `mcp__tea-rags__reindex_changes` with the project path:

   ```
   { "path": "<project-root>" }
   ```

   This is **incremental** — only changed files are re-embedded. Typical cost:
   under 5 seconds for ≤20 modified files. The cost is much smaller than the
   cost of running the wrapper against stale signals and producing wrong
   recommendations.

3. **Wait for `reindex_changes` to complete.** Only then make the tea-rags
   search call(s) in the wrapper's Step 1+.

## When to skip

- The wrapper does **not** call any tea-rags search tool (e.g.
  `dinopowers:writing-skills` authors SKILL.md and does not search code).
- The session has made **zero** file edits (read-only debugging / exploration
  only).
- The user has explicitly said "skip reindex" for this turn (rare — honor it but
  warn that signals may be stale).
- The just-edited files are **outside** the project root (e.g. system config,
  scratch notes elsewhere).

## When to retry

- If `reindex_changes` returns an error, surface it to the user. **DO NOT**
  silently proceed with a stale index — degraded wrapper output without warning
  is worse than failing loudly.
- If the search call afterwards still returns empty for paths the user clearly
  named (e.g. they said "the test I just wrote in `chunker.test.ts`" and search
  finds no chunks for that file), call `reindex_changes` once more — it's
  possible the index hadn't fully committed.

## Why this exists

Wrapper skills layer their value on top of search results. Stale index = empty
results = wrapper provides no measurable advantage over the parent
`superpowers:*` skill. The user reported this exact failure mode
(test-driven-development wrapper falling back to direct superpowers chain
because tea-rags found no matches for newly-written test files). Auto-reindex
via this protocol prevents the silent degradation.

Long-term: a hook-based auto-reindex (PostToolUse on Edit/Write + PreToolUse on
tea-rags search) would make this protocol unnecessary. Until that's built, every
wrapper that searches MUST honor this checklist as Step 0.
