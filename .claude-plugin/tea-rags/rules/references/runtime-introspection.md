# Runtime Introspection

Tea-rags exposes a live registry of presets, signals, filters, and infra state
through MCP resources and tool responses. Agents do NOT need to guess preset
names, signal keys, or filter syntax — fetch the truth at runtime.

When to read this file: a search returned `driftWarning`; you need to build a
custom rerank but don't know available weight keys; embedding / qdrant is
unreachable and you want a full health report; a result has a `rankingOverlay`
you need to interpret.

## MCP Resources Catalog

Read with `ReadMcpResourceTool(server: "tea-rags", uri: "<uri>")`. These are
generated from the live registry, so they always reflect what THIS build
supports — no stale references.

| URI                                | When to read                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tea-rags://schema/overview`       | First time in a session; catalog of resources + destructive tools warning                           |
| `tea-rags://schema/presets`        | Before picking a rerank preset — full preset list with signals + tools each preset is registered on |
| `tea-rags://schema/signals`        | Before building a `{custom: {...}}` rerank — full weight-key catalog (the ONLY canonical list)      |
| `tea-rags://schema/filters`        | Before writing a raw `filter:` block — operators, payload keys, file vs chunk level                 |
| `tea-rags://schema/signal-labels`  | Before interpreting `value/label` pairs in ranking overlay — explains label resolution algorithm    |
| `tea-rags://schema/search-guide`   | Need concrete parameter examples per tool                                                           |
| `tea-rags://schema/indexing-guide` | Indexing options, git metadata switches                                                             |

Never invent a preset name, signal key, or filter operator. Read the resource —
it is cheap and authoritative.

## get_index_status — Infra Health

`get_index_status(project: "<alias>")` returns the standard index metadata PLUS
an `infraHealth` block:

```jsonc
{
  "infraHealth": {
    "qdrant": {
      "url": "http://127.0.0.1:53578",
      "status": "green",
      "optimizer": "ok",
    },
    "embedding": {
      "url": "http://localhost:11434",
      "reachable": false,
      "provider": "ollama",
    },
    "enrichment": {
      "git": { "file": "healthy", "chunk": "healthy" },
    },
  },
}
```

Use this as the FIRST debug step when:

- A semantic call fails with a connection or timeout error
- The prime digest shows `embedding: unavailable` or `qdrant: red`
- An indexing run finished but searches return empty / stale results
- A trajectory's enrichment looks incomplete

Pair with the "Embedding Unavailable" rule in `search-cascade.md`: if
`embedding.reachable === false`, ask the user to start the embedding backend via
`AskUserQuestion` before downgrading the search strategy.

## get_index_metrics — Per-Project Calibration

`get_index_metrics(project: "<alias>")` returns per-language × per-scope
(`source` / `test`) percentile labelMaps for every numeric signal, plus the
current distribution.

Why this matters: a `commitCount` of 8 is "high" in one project and "typical" in
another. The labelMap tells you THIS project's thresholds. Use it when:

- The user asks "what counts as old / churn-heavy / silo'd in this codebase?" —
  read the labelMap, do not guess
- You're building a custom filter with `minCommitCount` / `maxAgeDays` and want
  a meaningful threshold (e.g. `>= labelMap.high`)
- A rerank result's `value/label` pair surprises you — verify which bucket the
  value falls in for this language scope

Returned shape (abbreviated):

```jsonc
{
  "signals": {
    "typescript": {
      "git.file.commitCount": {
        "source": {
          "labelMap": { "low": 1, "typical": 3, "high": 8, "extreme": 20 },
        },
        "test": {
          "labelMap": { "low": 1, "typical": 2, "high": 5, "extreme": 12 },
        },
      },
    },
  },
}
```

## driftWarning — Schema Drift Detection

Every search response can include a top-level `driftWarning` field when the live
code defines payload signals that are NOT yet present in the indexed payloads
(or vice versa). Treat it as a hint, not an error:

- Surface the warning to the user when it appears — they need to know some new
  analytics fields will be missing from results until they reindex
- Do NOT auto-trigger `force_reindex` — that decision is the user's (large
  codebases = long reindex). See `tea-rags:force-reindex` skill
- For tea-rags self-test only: full reset via `force_reindex` is the documented
  path (see project CLAUDE.md MCP testing section)
- For regular projects: incremental `index_codebase` handles most drift
  scenarios

## rankingOverlay — Why This Result Was Ranked Here

Every reranked search result carries a `rankingOverlay` field that explains the
score:

```jsonc
{
  "rankingOverlay": {
    "derived": {
      "recency": 0.61,
      "churn": 0.42,
      "ownership": 0.18,
    },
    "raw": {
      "file": { "ageDays": { "value": 142, "label": "old" } },
      "chunk": { "commitCount": { "value": 12, "label": "high" } },
    },
  },
}
```

- `derived` — normalized 0-1 signals fed into the score. The keys come from the
  chosen preset's weights or the overlay mask.
- `raw.file` / `raw.chunk` — original payload values + labels (resolved via
  `signal-labels` resource).

Use the overlay to:

- Answer "why this result?" without re-running the search
- Detect pattern combinations from `references/signal-interpretation.md` (god
  module vs bug attractor, healthy owner vs toxic silo, etc.)
- Spot confidence-clamped labels (small-N) — see `signal-interpretation.md` →
  "Interpretation anti-patterns" #8

Never re-rank a single result by Read'ing its file. The overlay is the
explanation layer.
