# Bug Hunt — fresh / uncommitted probe details, audit mode

On-demand detail for probes b and c of Non-negotiable 3. SKILL.md owns the three
probe lines and step 0; this file owns why they work and their edge cases.

## Fresh probe

**Why:** `bugHunt` confidence-dampens `volatility` / `relativeChurnNorm` /
`bugFix` by `commitCount`. Code with 1–2 fresh commits ranks low in the
historical search — fresh bug drowns under old hotspots. Probe restricts
population to recently changed files so it surfaces.

- **`modifiedAfter: "<ISO date>"`** — always filters `git.file.lastModifiedAt`
  (file-level) whatever `level` says; absolute timestamp, not index-time age.
- **Do NOT pass `level: "file"`.** `level` also sets result granularity — `file`
  regroups results into files; probe needs chunks (methods).
- **`maxAgeDays: <N>`** (default chunk level) = narrower method-grain probe:
  chunks whose OWN last commit ≤ N days before QUERY time (`0` = within a day).
  Misses chunks without chunk-level commit data (see `filter-building` chunk age
  caveat) → `modifiedAfter` stays default probe.
- Committed history only: walk emits committed files → untracked /
  never-committed file carries NO `lastModifiedAt` → outside every time filter.
  Uncommitted edit to committed file → timestamp = last COMMIT → probe misses
  edit. Both → Uncommitted probe.
- Probe hit whose code matches symptom = **fresh suspect** — triage by fresh
  class, not by `bugFixRate`.

## Uncommitted probe

**Why:** git signals = commit history. Working-tree edits (modified, staged,
untracked) have none → fresh probe misses them, historical search ranks them by
pre-edit history. "Broke after my change" = edit not yet committed.

- **Source:** `git status --porcelain -uall` — path column only, never diff
  content. Working-tree state, not history → Rule 2 intact. `-uall` lists every
  file of a new untracked dir; without it → one `?? dir/` line, matches no file
  as exact brace entry → new module invisible.
- **pathPattern:** each path brace-joined as exact relativePath (pathPattern
  rules). Rename `old -> new` → `new`; deleted (`D`) → drop. Git root ≠ indexed
  root → strip prefix. Search scope set → keep paths inside it.
- Same tool + query + rerank + limit as a/b, same message (linked worktree:
  `hybrid_search` — its `sparse` floor scores the edited file from the tree).
- Hit matching symptom = **uncommitted suspect** — labels describe committed
  version; symptom fit decides.
- Hit with `treeState` = index's pre-edit copy: text and line range stale, still
  the uncommitted suspect. Judge the edit from
  `find_symbol project=<alias> path=<your working directory>` (current tree),
  never from the row or a `Read` of its line range.
- Main checkout: probe reads INDEXED content → step 0 listed paths → reindex
  BEFORE the search message (`tea-rags://guide/freshness` uncommitted-edits
  row). Never wait for prime stale — blind to working-tree edits. Reindex failed
  → say so; zero hits ≠ clean. Linked worktree: no reindex — `treeState` rule
  above.

## Audit mode (optional)

`filter:{presets}` is available but NOT the default for bug-hunt.

Use it ONLY for a **query-absent risk scan** — "what areas of payments are
high-risk right now?" with no specific symptom. Example:

```json
{ "filter": { "presets": "panicZone" }, "query": "payments" }
```

**NEVER use for a symptom search** — `panicZone` (high churn filter) drops a
recently-edited stable file, killing recall. `bugHunt` already applies the
`production` hygiene filter (no tests/docs/boilerplate) without churn narrowing;
overlay surfaces risk after the fact.
