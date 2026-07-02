# Runtime Introspection

Tea-rags exposes live registry of presets, signals, filters, infra state via MCP
resources + tool responses. Agents do NOT guess preset names, signal keys,
filter syntax — fetch truth at runtime.

Read this file when: search returned `driftWarning`; building custom rerank but
don't know weight keys; embedding/qdrant unreachable + want health report;
result has `rankingOverlay` to interpret.

## MCP Resources Catalog

Read via `ReadMcpResourceTool(server: "tea-rags", uri: "<uri>")`. Generated from
live registry — always reflect THIS build, no stale refs.

| URI                                | When to read                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `tea-rags://schema/overview`       | First time in a session; catalog of resources + destructive tools warning                           |
| `tea-rags://schema/presets`        | Before picking a rerank preset — full preset list with signals + tools each preset is registered on |
| `tea-rags://schema/signals`        | Before building a `{custom: {...}}` rerank — full weight-key catalog (the ONLY canonical list)      |
| `tea-rags://schema/filters`        | Before writing a raw `filter:` block — operators, payload keys, file vs chunk level                 |
| `tea-rags://schema/signal-labels`  | Before interpreting `value/label` pairs in ranking overlay — explains label resolution algorithm    |
| `tea-rags://schema/search-guide`   | Need concrete parameter examples per tool                                                           |
| `tea-rags://schema/indexing-guide` | Indexing options, git metadata switches                                                             |

Never invent preset name, signal key, filter operator. Read the resource —
cheap + authoritative.

## get_index_status — Infra Health

`get_index_status(project: "<alias>")` returns standard index metadata PLUS
`infraHealth` block:

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

FIRST debug step when:

- Semantic call fails with connection/timeout error
- Prime digest shows `embedding: unavailable` or `qdrant: red`
- Indexing run finished but searches return empty/stale results
- Trajectory's enrichment looks incomplete

Pair with "Embedding Unavailable" rule in `search-cascade.md`: if
`embedding.reachable === false`, ask user to start embedding backend via
`AskUserQuestion` before downgrading search strategy.

## get_index_metrics — Per-Project Calibration

`get_index_metrics(project: "<alias>")` returns per-language × per-scope
(`source` / `test`) percentile labelMaps for every numeric signal, plus current
distribution.

Why: `commitCount` of 8 is "high" in one project, "typical" in another. labelMap
tells THIS project's thresholds. Use when:

- User asks "what counts as old / churn-heavy / silo'd in this codebase?" — read
  labelMap, don't guess
- Building custom filter with `minCommitCount` / `maxAgeDays` + want meaningful
  threshold (e.g. `>= labelMap.high`)
- Rerank result's `value/label` pair surprises you — verify which bucket the
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

Every search response can include top-level `driftWarning` field when live code
defines payload signals NOT yet present in indexed payloads (or vice versa).
Treat as hint, not error:

- Surface warning to user when it appears — new analytics fields missing from
  results until reindex
- Do NOT auto-trigger `force_reindex` — user's decision (large codebases = long
  reindex). See `tea-rags:force-reindex` skill
- tea-rags self-test only: full reset via `force_reindex` is documented path
  (see project CLAUDE.md MCP testing section)
- Regular projects: incremental `index_codebase` handles most drift scenarios

## rankingOverlay — Why This Result Was Ranked Here

Every reranked search result carries `rankingOverlay` field explaining the
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

- `derived` — normalized 0-1 signals fed into score. Keys come from chosen
  preset's weights or overlay mask.
- `raw.file` / `raw.chunk` — original payload values + labels (resolved via
  `signal-labels` resource).

Use overlay to:

- Answer "why this result?" without re-running search
- Detect pattern combinations from `references/signal-interpretation.md` (god
  module vs bug attractor, healthy owner vs toxic silo, etc.)
- Spot confidence-clamped labels (small-N) — see `signal-interpretation.md` →
  "Interpretation anti-patterns" #8

Never re-rank single result by Read'ing its file. Overlay is the explanation
layer.
