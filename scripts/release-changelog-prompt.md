# Product Changelog — Agent Instructions

You are post-processing a published release. Input available in the working dir:

- `commits.json` — array of `{ hash, subject, body }` for this release range.

Your job is to turn raw commits into a **product** changelog: grouped by what
the release does for a tea-rags **user**, described in terms of the value they
get — not the internal mechanism. Conventional commits carry a `type(scope):`
prefix — the scope is your primary signal for which product theme an item
belongs to. If a subject is ambiguous, read its `body` for context.

## Produce `release-notes.json` ONLY (no prose, no markdown to stdout)

Write a file `release-notes.json` matching this schema exactly:

```json
{
  "version": "1.30.0",
  "date": "2026-06-06",
  "compareUrl": "https://github.com/artk0de/TeaRAGs-MCP/compare/v1.29.0...v1.30.0",
  "repoUrl": "https://github.com/artk0de/TeaRAGs-MCP",
  "groups": [
    {
      "theme": "codeIntel",
      "items": [
        {
          "description": "Ruby call-graph navigation (find-callers, impact, blast-radius) returns complete results through chained and ActiveRecord-heavy calls",
          "commits": ["20d6d31", "e4b476f", "a913793", "b796f89"]
        }
      ]
    },
    {
      "theme": "fixes",
      "items": [
        {
          "description": "gitignore whitelist patterns now descend into subdirectories",
          "commits": ["90d8bd8"]
        }
      ]
    }
  ],
  "allCommits": [
    {
      "hash": "20d6d31",
      "subject": "feat(trajectory): Ruby receiver type-propagation engine"
    },
    {
      "hash": "90d8bd8",
      "subject": "fix(ingest): gitignore whitelist subdir descent"
    },
    { "hash": "9344854", "subject": "refactor(infra): relocate ConfigError" }
  ]
}
```

## Product themes (the `theme` key)

Group items into this **fixed** set of product themes. Use the `key` (left
column) as the `theme` value. The renderer supplies the emoji heading and orders
themes for you — omit any theme with no items; never invent a new theme key.

| `theme` key | Product surface        | Source scopes (map `type(scope):` → theme)                                 |
| ----------- | ---------------------- | -------------------------------------------------------------------------- |
| `search`    | Search & ranking       | `explore`, `rerank`, `hybrid`, `signals`, `presets`, `filters`             |
| `codeIntel` | Code intelligence      | `trajectory`, `codegraph`, `mcp` (callers/callees/trace_path)              |
| `indexing`  | Indexing & performance | `ingest`, `pipeline`, `chunker`, `embedding`, `embedded`, `qdrant`, `perf` |
| `language`  | Language support       | `language`, per-language scopes (ruby/python/…)                            |
| `workflow`  | CLI & workflow         | `cli`, `config`, `api`, `mcp` (tooling), `factory`, `bootstrap`            |
| `fixes`     | Fixes                  | any **user-visible** `fix` (this theme overrides scope mapping)            |

For a scope not in the table, pick the closest theme by reading the `body`. If a
multi-scope commit (`type(a,b):`) spans themes, use the one that best matches
the user-facing benefit.

## Rules

1. **Only `feat` and `fix` commits are candidates for `groups`.** Everything
   else — `refactor`, `perf`, `docs`, `test`, `chore`, `style`, `build`, `ci` —
   is EXCLUDED from `groups` entirely. They still appear in `allCommits` (the
   Full Commits spoiler).

2. **Benefit framing — describe the value, not the mechanism.** For each item,
   answer: _"so what, for someone using tea-rags?"_ State the capability the
   user gains or the symptom that stops happening. Describe the result, in plain
   language a user understands.
   - GOOD: "Ruby call-graph navigation returns complete results through chained
     and ActiveRecord-heavy calls"
   - BAD: "Ruby receiver type-propagation engine resolves types through
     multi-hop call chains via TypeFactStore with source precedence"

3. **Banned vocabulary + drop internal-only items (do NOT fabricate value).**
   Product `description`s must NOT name internal symbols: class/type names,
   method names, error types, or internal metric names (e.g. `TypeFactStore`,
   `WorkerDispatchPool`, `QdrantOperationError`, `CHA`, `inProjectEdgeRecall`,
   `ivarTypes`). **If you cannot state a user-facing benefit for a commit
   without naming an internal symbol, the commit is internal-only — leave it OUT
   of `groups`.** Do not invent a benefit to justify including it. It still
   appears verbatim in `allCommits`. This drops substrate-only feats (e.g.
   "class hierarchy edges persisted as substrate") and internal-only fixes (e.g.
   "throw a typed error instead of a plain Error") from the product view.

4. **Fixes go to the `fixes` theme.** A user-visible `fix` becomes an item under
   `theme: "fixes"` regardless of its scope. Internal-only fixes are dropped per
   rule 3. There is no per-item `kind` field — the `fixes` theme is the marker.

5. **Collapse related commits.** Several commits forming one capability (e.g. an
   epic) collapse into ONE item; list all their hashes in `commits[]`. Same for
   related fixes.

6. **Every item lists its commit hashes** (7-char short) in `commits[]` — kept
   for traceability even though the product bullets render without inline links.

7. **`allCommits`** = EVERY commit in range (feat, fix, refactor, chore — all of
   them), verbatim subject, for the Full Commits spoiler.

8. **Always set `date`** to the release date (YYYY-MM-DD) — it appears in both
   the changelog and the GitHub release header.

Do not emit anything to stdout. The only output is the `release-notes.json`
file.
