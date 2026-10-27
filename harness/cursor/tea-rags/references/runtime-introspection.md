# Runtime Introspection

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Read when: get_index_status / prime reports index drift; custom rerank, weight
keys unknown; embedding/qdrant unreachable → health report; `rankingOverlay` to
interpret. Base contract (infraHealth / drift / presetFilterNotice / overlay) →
`tea-rags://guide/overview` "Observability hooks". Here: details only.

## Resources

Read resource `<uri>` (MCP resource read; no resource tool →
`tea-rags resource "<uri>" --path "$PWD"`). Generated from live registry = THIS
build. Never invent preset name, signal key, filter operator — read resource.

| URI                                              | When to read                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `tea-rags://guide/overview`                      | first time in session; resource catalog, response shape, params                         |
| `tea-rags://guide/presets`                       | before picking rerank preset — signals per preset                                       |
| `tea-rags://guide/signals`                       | before `{custom: {...}}` rerank — ONLY canonical weight-key list                        |
| `tea-rags://guide/filters`                       | before raw `filter:` — operators, fields, named `{presets}`                             |
| `tea-rags://guide/signal-labels`                 | before reading `value/label` pairs — label resolution algorithm                         |
| `tea-rags://guide/search-examples`               | concrete param examples per tool, pagination                                            |
| `tea-rags://guide/indexing`                      | `index_codebase` options, git metadata                                                  |
| `tea-rags://project/<alias>/digest`              | status, `## Drift`, language capability; `## Infra` when unhealthy                      |
| `tea-rags://project/<alias>/metrics?section=<s>` | `thresholds` / `labelMap` / `capability` / `resolve` / `registry` (+`&language=<lang>`) |

## get_index_status — infraHealth

`get_index_status(project: "<alias>")` → index metadata + `infraHealth`:

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

- semantic call fails, connection/timeout error
- digest carries `## Infra` (emitted only when unhealthy: qdrant `red`,
  embedding endpoint `unavailable`) — digest = snapshot; confirm live here
- index run finished, searches empty/stale
- trajectory enrichment looks incomplete

**Failed optimizer.** Optimizer `error: <message>` → Infra block (and digest
`## Infra`) carries ready `Run: tea-rags qdrant recover --project <alias>` line.
Re-applies collection's CURRENT optimizer config (no value change; Qdrant 1.18
recreates optimizer, clears error), verifies — no daemon restart, no reindex.
Writes to Qdrant → relay to user, never run unasked. Still failing → live cause
(disk, memory, segment); check Qdrant log.

`embedding.reachable === false` → `tea-rags://guide/degraded`: ask user to start
embedding backend before downgrading search strategy.

## Project calibration

Same `commitCount` = "high" in one project, "typical" in another. Thresholds per
language × scope (`source` / `test`): read
`tea-rags://project/<alias>/metrics?section=labelMap&language=<lang>` (band
table: `section=thresholds`). Use when:

- user asks "what counts as old / churn-heavy / silo'd here?" — read, don't
  guess
- custom filter `minCommitCount` / `maxAgeDays` needs meaningful threshold (e.g.
  `>= labelMap.high`)
- overlay `value/label` surprises — verify bucket for that language scope

## Index drift — details

Hint, not error. Reported ONLY by `get_index_status` and prime (digest
`## Drift`) when index stamp ≠ running build (payload keys, language versions,
indexing env, indexed commit). Read answers (search, `find_symbol`, graph) never
carry it — a read answer never triggers a repair.

- Surface to user. Lists moved axes + ONE `Run:` line = cheapest repair
  (`--force-enrichments <scope>` enrichment-owned drift; `--force` only when
  chunk set moved; plain incremental when only HEAD moved).
- NEVER auto-run `--force-enrichments` / `--force` — user decides (large repo =
  long reindex). `--force` → `/force-reindex`. Plain incremental `Run:` (only
  HEAD moved) runs without asking, like stale banner.
- Enable-flag rows (`CODEGRAPH_ENABLED` / `TRAJECTORY_GIT_ENABLED`) describe
  process READING index — each surface answers for own process. Digest
  re-applies `CODEGRAPH_ENABLED` from registry → row never appears there,
  absence says nothing about server. Codegraph flag → `get_index_status` (server
  answers for itself) or `metrics?section=registry`.
- Re-read freely: digest `## Drift` and `get_index_status` report the current
  stamp on every call, nothing is consumed; clears after the index run.
- tea-rags self-test only: full reset via `force_reindex` (project CLAUDE.md MCP
  testing section).

## rankingOverlay — why ranked here

Every reranked result carries `rankingOverlay`, metaOnly included:

```jsonc
{
  "rankingOverlay": {
    "preset": "techDebt",
    "file": {
      "commitCount": { "value": 37, "label": "extreme" },
      "imports": ["./a", "./b"],
      "fanIn": { "value": 3, "label": "popular" },
    },
    "chunk": { "bugFixRate": { "value": 40, "label": "concerning" } },
  },
}
```

- Keys = preset `overlayMask` fields (custom weights → each weight's source
  fields), bare name, grouped by level. Flat structural: file-wide (`imports`,
  `moduleLines`) under `file`, per-method (`methodLines`, `methodDensity`) under
  `chunk`. `level: "file"` result → no `chunk` block.
- `{value,label}` when labelled (→ `tea-rags://guide/signal-labels`), else raw.
  Result table (2+ results): two columns `rankingOverlay.chunk.<field>.value` /
  `.label`.
- Labels ONLY here. Payload = raw values at filter-key paths; a `metaOnly`
  payload carries none unless `fields` names them (`["git"]` = whole subtree).
  Contract owner: `tea-rags://guide/overview` → `### metaOnly`.

Use overlay to: answer "why this result?" without re-search; detect pattern
combos (`signal-interpretation.md`: god module vs bug attractor, healthy owner
vs toxic silo, …); spot confidence-clamped small-N labels
(`signal-interpretation.md` → "Interpretation anti-patterns" #8).

Never re-rank single result by reading its file. Overlay = explanation layer.
