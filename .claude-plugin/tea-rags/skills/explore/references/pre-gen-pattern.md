# PRE-GEN Pattern

Triggered by Step 0 classification. Gathers actionable context for code
generation — files, risk signals, overlay labels.

## PG-1. DISCOVER

Find target area files. Select tool directly:

- **Behavior/intent query** → `semantic_search` (query=$ARGUMENTS,
  metaOnly=true, limit=10, documentation="exclude")
- **Known symbol + context** → `hybrid_search` (query=$ARGUMENTS, metaOnly=true,
  limit=10, documentation="exclude")

Add `pathPattern` if module is known. Add `language` if polyglot codebase.
`documentation="exclude"` prevents RFC/docs from taking result slots.

**Checkpoint:** Found target files (3-5 paths)?

- YES → extract pathPattern, proceed to PG-2
- NO → reformulate query (narrower scope, different angle), retry once

## PG-2. SIGNAL LOOKUP

For each key symbol from PG-1 (2-5 symbols), call `find_symbol` with rerank to
get overlay labels. One call per symbol — find_symbol is instant (scroll, no
embedding).

```
find_symbol:
  symbolId: <symbol name from PG-1>
  path: <project>
  rerank: "techDebt"          ← any preset works, overlay is preset-independent
  metaOnly: false             ← need overlay labels
```

Extract per-symbol: bugFixRate, ageDays, churnVolatility, commitCount,
blameDominantAuthor, blameDominantAuthorPct (live-line owner — used for silo
detection and "who must approve") and recentDominantAuthor,
recentDominantAuthorPct (recent committer — used for "who's loaded in"). These
feed DDG strategy selection.

**Interpretation:** when presenting overlay findings to the user (pre-gen
context or explore), do not read single signals in isolation. Consult
`references/signal-interpretation.md` for pair diagnostics — especially when
churn, age, or ownership are high. Single-signal conclusions mislead (high churn
≠ active development; mono ownership ≠ silo risk).

## PG-3. DEEP TRACE (optional)

If specific symbols need structural understanding before generation:

- `find_symbol` for 1-2 key symbols (definition + imports)
- Fallback: `hybrid_search` if find_symbol returns 0

**Limit:** Do NOT trace call chains or dependency trees.

## PG-4. OUTPUT

```
Pre-generation context for: [area]

Files: [list with pathPattern-ready format]
Language: [detected language]
Symbols with overlay:
  - symbolName: { bugFixRate, ageDays, churnVolatility, commitCount,
                  blameDominantAuthor, blameDominantAuthorPct,
                  recentDominantAuthor, recentDominantAuthorPct }

Context for generation:
  - pathPattern: [ready for data-driven-generation]
  - overlay labels: [per-symbol from PG-2]
```

Output is self-contained. data-driven-generation reads overlay labels directly.
