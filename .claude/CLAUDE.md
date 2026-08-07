# tea-rags — Project Rules

## Rule File Convention (MANDATORY)

Every `.claude/rules/*.md` MUST start with YAML frontmatter declaring scoped
source-tree paths. Format:

```yaml
---
paths:
  - "src/core/<glob/of/affected/files>"
  - "tests/<glob/optional>"
---
```

`paths` = picomatch globs pinpointing code areas rule constrains. Tools
surfacing rules by file location filter via frontmatter. No frontmatter =
invisible = broken rule. Project-wide rule: declare `paths: ["**/*"]`
explicitly, don't omit.

## Process Rules

- `.claude/rules/silo-pairing.md` — commits touching deep-silo files must
  include `Why:` line.
- `.claude/rules/domains-language.md` — Factory-encapsulates-construction,
  worker-thread DI via injected module-path, language-migration test rule
  (preserve examples, validate counts). Scoped `domains/language`, chunker,
  codegraph, `api/internal`.
- `.claude/rules/naming.md` — qualify generic suffixes
  (`Outcome`/`Strategy`/`Metadata`/`Result`…) with domain context, unambiguous
  at use. Scoped project-wide (`**/*`).
- `.claude/rules/worktree-beads-lifecycle.md` — tearing down a worktree (merge
  OR abandon) MUST first settle every bead the branch touched: close with
  evidence, reset to `open`, or hand to a named live worktree. Recover the bead
  set from `git log main..worktree-<name>` before removal. Scoped project-wide
  (`**/*`).

## Terminology (MANDATORY)

### Signal Taxonomy

| Term                             | Definition                                                                                                                                               | Example                                                                                   | Where                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Signal** (raw)                 | Value stored in Qdrant payload. Defined by Provider. Not normalized.                                                                                     | `ageDays=142`, `commitCount=23`, `bugFixRate=35`                                          | `payload.git.file.*`, `payload.git.chunk.*`                                                                                    |
| **Derived Signal**               | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets.                            | `recency` (from ageDays), `ownership` (from blameDominantAuthorPct+blameAuthors)          | `DerivedSignalDescriptor` in provider                                                                                          |
| **Structural Signal**            | Derived signal from payload structure, not from any trajectory provider.                                                                                 | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk`                         | Reranker built-in                                                                                                              |
| **Preset** (`RerankPreset`)      | Class with name, description, tools[], weights, overlayMask. 3-level hierarchy: Generic -> Trajectory -> Composite. Each preset is a class file.         | `class TechDebtPreset { tools: ["semantic_search"], weights: {...}, overlayMask: {...} }` | `trajectory/git/rerank/presets/`, `explore/rerank/presets/`                                                                    |
| **Overlay Mask** (`OverlayMask`) | Curates which signals appear in ranking overlay for a preset. `derived: string[]` + optional `raw: { file?, chunk? }`.                                   | `{ derived: ["age", "churn"], raw: { file: ["ageDays"] } }`                               | Each preset class                                                                                                              |
| **Ranking Overlay**              | Subset of raw + derived signals filtered by OverlayMask (or weight keys for custom), attached to each reranked result.                                   | `{ raw: { file: { ageDays: 142 } }, derived: { recency: 0.61 } }`                         | Reranker response                                                                                                              |
| **Stats**                        | Low-level descriptive statistics over the collection: count/min/max/mean/stddev/percentiles. Internal compute artifact, not for direct user consumption. | `count`, `mean`, `percentiles[25..95]`                                                    | `SignalStats` in `contracts/types/trajectory.ts`, `StatsCache` in `infra/stats-cache.ts`, `domains/ingest/collection-stats.ts` |
| **Metrics**                      | Consumer-facing aggregated frame built ON TOP of Stats — selects fields and attaches labels for the `get_index_metrics` MCP tool.                        | `{ min, max, mean, count, labelMap }`                                                     | `SignalMetrics` / `IndexMetrics` in `api/public/dto/metrics.ts`, built by `IndexMetricsQuery#buildSignalMetrics`               |

**Stats vs Metrics rule.** Stats = distribution math (compute/persist layer).
Metrics = polished user view (DTO layer). Builder one-directional: `SignalStats`
→ `SignalMetrics` via `buildSignalMetrics`. Never merge under one name — two
layers, different responsibilities. New low-level aggregates (count,
percentiles, mean, stddev) → `Stats` types. New user-facing MCP-exposed fields →
`Metrics` DTOs.

### Domain Terms

| Term                 | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Provider             | Trajectory that defines signals, derived signals, filters, and builds signal data.                                                     |
| Filter               | Qdrant filter condition builder. Defined by Provider.                                                                                  |
| Reranker             | Orchestrates derived signal extraction, adaptive bounds, scoring, and ranking overlay. Receives descriptors + resolved presets via DI. |
| SchemaBuilder        | Generates Zod schemas for MCP tools from Reranker's public API (DIP). Lives in api/.                                                   |
| Alpha-blending       | L3 confidence-weighted blending of file vs chunk signals: `effective = alpha * chunk + (1-alpha) * file`.                              |
| Confidence dampening | Quadratic per-signal dampening for unreliable statistical signals: `(n/k)^2` where k is signal-specific threshold.                     |
| Adaptive bounds      | Per-query normalization bounds computed from result set (p95), floored with defaults.                                                  |

### Path Shortcuts

All paths relative to `src/core/`.

| Alias               | Path                                             |
| ------------------- | ------------------------------------------------ |
| `api-public`        | `api/public/`                                    |
| `api-internal`      | `api/internal/`                                  |
| `dto`               | `api/public/dto/`                                |
| `explore`           | `domains/explore/`                               |
| `explore-strats`    | `domains/explore/strategies/`                    |
| `explore-presets`   | `domains/explore/rerank/presets/`                |
| `ingest`            | `domains/ingest/`                                |
| `pipeline`          | `domains/ingest/pipeline/`                       |
| `chunker`           | `domains/ingest/pipeline/chunker/`               |
| `chunker-hooks`     | `domains/ingest/pipeline/chunker/hooks/`         |
| `enrichment`        | `domains/ingest/pipeline/enrichment/`            |
| `sync`              | `domains/ingest/sync/`                           |
| `traj-git`          | `domains/trajectory/git/`                        |
| `traj-git-signals`  | `domains/trajectory/git/rerank/derived-signals/` |
| `traj-git-presets`  | `domains/trajectory/git/rerank/presets/`         |
| `traj-git-stats`    | `domains/trajectory/git/stats/`                  |
| `traj-static`       | `domains/trajectory/static/`                     |
| `traj-static-stats` | `domains/trajectory/static/stats/`               |
| `contracts`         | `contracts/`                                     |
| `infra`             | `infra/`                                         |
| `migration`         | `domains/maintenance/migration/`                 |
| `bootstrap`         | `bootstrap/`                                     |

### Design Principle: Don't Generate — Interrogate

Agent instinct = GENERATE variants fast, move on. User strength = INTERROGATE
each until it breaks or holds.

**The anti-pattern that wastes time:**

1. Agent proposes "pure function renderOutline()" → user says it's wrong
2. Agent proposes "OutlineRenderer with strategies" → user says naming is wrong
3. Agent proposes "ChunkGroupView" → user says view doesn't reflect reality
4. Agent proposes "ChunkGrouper" → user approves

4 names because agent generated instead of thinking; user explained WHY each
wrong. Should've asked: "what does component DO?" → groups chunks →
ChunkGrouper. One step, not four.

**Rule:** Before proposing name/structure, answer three:

1. What does it DO? (verb → noun)
2. Who OWNS it? (domain)
3. What's the INTERFACE? (inputs/outputs)

Can't answer all three — don't propose, investigate first.

**Why:** User time > agent compute. Every rejected proposal = wasted human
attention. Get it right in fewer rounds.

### Naming Conventions

- `buildFileSignals` / `buildChunkSignals` (NOT
  buildFileMetadata/buildChunkMetadata)
- `GitFileSignals` / `GitChunkSignals` (NOT GitFileMetadata/ChunkChurnOverlay)
- `computeFileSignals` / `computeChunkSignals` (NOT
  computeFileMetadata/computeChunkOverlay)
- `fileSignalTransform` (NOT fileTransform)
- `Signal` type (NOT FieldDoc)
- `gitSignals: Signal[]` (NOT gitPayloadFields: FieldDoc[])

## Automation Agents

### coverage-expander (MANDATORY when commit fails coverage threshold)

Pre-commit fails
`ERROR: Coverage for <metric> (X%) does not meet global threshold (Y%)` → MUST
delegate to `coverage-expander` subagent, not inline tests. The subagent is a
thin entry point at `.claude/agents/coverage-expander.md`; its methodology lives
in the agent-only `expand-coverage` skill (`.claude/skills/expand-coverage/`,
`user-invocable: false`). That skill:

- **freshness gate** — incrementally reindexes local main before searching, so
  corner-case discovery sees the just-committed source (never a stale index)
- **corner-case discovery** — reads `coverage/coverage-final.json` hit maps for
  the EXACT uncovered branches, then `find_symbol` / `hybrid_search` /
  `find_similar` / `get_callers` to understand and pattern-match them (no `Read`
  of `src/`)
- parses `coverage/coverage-summary.json` instead of grepping vitest stdout
- runs `npm run test:coverage` at most 2× (3× with one retry) per invocation —
  hard-capped to keep latency bounded
- never modifies production code, configs, or thresholds; never adds `v8 ignore`
  / `eslint-disable`; never rewrites passing tests

Invoke via `Agent` tool, `subagent_type: "coverage-expander"`,
`run_in_background: true` (MANDATORY — coverage runs are slow, 30–90s each; the
sub-agent must run as a background job so the session isn't blocked, then act on
its completion notification). Pass failing pre-commit output + (if relevant)
commit-introduced files. Agent writes test files only — parent session commits.
The skill is background-safe: fully autonomous, no interactive questions, its
final report is the handoff.

Do NOT use for unrelated coverage exploration / test authoring outside failing
pre-commit hook — early-exit stops it when thresholds met.

## MCP Integration Testing — `npm link` workflow

tea-rags MCP server registered in Claude Code uses **globally-installed npm
package** (`npm i -g tea-rags-mcp`), NOT local `build/`. Local `npm run build`
produces `build/` JS but running server keeps pointing at global install.
Without re-linking, MCP-side integration tests via `mcp__tea-rags__*` exercise
last-published, not local changes.

### Sequence (worktree → merge)

Point global link at **worktree** build for MCP-side testing. After merge, do
NOT relink main — parallel sessions may have own worktree builds linked;
relinking main clobbers another session's test build. Link =
per-session/per-worktree concern; main carries canonical _source_ after merge,
not necessarily global link.

```bash
# 1. Worktree: build the worktree branch + point global tea-rags at it
cd .claude/worktrees/<branch>
npm run build
npm link

# 2. Reconnect MCP servers in Claude Code.
#    Run mcp__tea-rags__* integration tests against the worktree build.

# 3. After tests pass: MERGE the worktree branch into main.
cd /Users/artk0re/Dev/Tools/tea-rags-mcp
git merge worktree-<branch> --no-ff

# Do NOT relink main here. Leave the global link where your session needs it
# (typically the worktree build you just tested). A parallel session may have its
# own build linked — relinking main would yank the link out from under it. Relink
# a specific checkout only when YOU need the global link to point there.
```

Why no auto main relink after merge: global `npm link` = single machine-wide
pointer, but sessions test in parallel each against own worktree build. Forcing
link back to main breaks concurrent session mid-test. Link owned by whoever's
actively testing — point at build you need, leave it. Once merged, worktree
source preserved on main regardless of link; later `npm link` from any checkout
reproduces it.

### Why build AND link each time

- `npm link` registers current `package.json` path as global symlink source.
  Does NOT trigger build — consumer (MCP server) loads whatever `build/`
  contains at next start.
- `npm run build` ensures `build/` reflects current source. Skipping = link
  points at stale compiled output.

### Never auto-build / auto-reindex (MANDATORY)

- **Do NOT `npm run build && npm link` a worktree automatically** when MORE than
  one worktree active (`git worktree list` shows >1 under `.claude/worktrees/` —
  parallel sessions). Wait for explicit "build"/"собери". It is the **relink**
  that collides with a concurrent session, so this gate gates the linked build;
  a bare local build is unrestricted (see below).
- **Single active worktree is the exception:** `git worktree list` shows exactly
  one → MAY build automatically to verify — no parallel session to disturb.
- **Pair the build with `npm link` when the MCP server must load it
  (MANDATORY).** For MCP-side testing the global `tea-rags` pointer has to reach
  the fresh `build/` — there, run `npm run build && npm link` as **one unit**,
  or the compiled output is never the one loaded. Link is yours; parallel
  session re-links on resume.
- **A bare `npm run build` in a worktree is FINE when the build is only needed
  locally.** It touches nothing global, so it cannot collide with a parallel
  session — **the link is the shared resource, not the build.** Standing case: a
  fresh worktree has no `build/`, and `chunker/infra/pool.ts` forks the
  _compiled_ worker (`POOL_DIR` rewrites `/src/` → `/build/`), so every
  worker-forking test — and therefore pre-commit — fails until the worktree is
  built once. Build it, don't link it. (Tracked as `tea-rags-mcp-hyj9d`.)
- **Reindex / `index-codebase --force` is ALWAYS user-gated**, regardless of
  worktree count — rewrites shared Qdrant index, depends on ollama embeddings
  (can flap mid-run). NEVER chain reindex off build; stop at green tests, wait
  for explicit "reindex"/"замер".
- **Commit after successful live validation is auto-authorized.** User-triggered
  live validation SUCCEEDS (reindex clean + measured resolveSuccessRate delta
  confirms change) → MAY commit on worktree branch without explicit "commit" —
  successful validation is authorization. Still worktree-only: never merge to
  main or push without explicit ask.

### When to skip the link-flip entirely

- Pure docs/spec/plan changes not touching `src/` — no rebuild.
- Type-only changes not altering runtime behavior — local `npm test` covers
  regression; MCP-side run gives same result.

### Anti-patterns

- **Linking without building.** Leaves stale `build/` under link. Run
  `npm run build` first.
- **Building without linking _when the MCP server is what must load it_.** Bare
  `npm run build` in a worktree leaves the global `tea-rags` pointer on another
  checkout — new `build/` compiled but never loaded. Scoped to MCP-side testing:
  a build done only to make local tests runnable is correct _unlinked_.
- **Building+linking main BEFORE merging.** Main's `build/` doesn't yet have
  worktree changes. Global link points at main's pre-merge state, MCP tests
  regress to un-tested baseline.
- **Relinking main after merge by reflex.** Global link machine-wide, shared
  across parallel sessions; yanking back to main breaks concurrent session
  mid-test. Relink checkout only when your session needs it. Caveat: removing
  worktree the link points at breaks link — relink before `git worktree remove`.
- **Publishing instead of linking** as quick test path. `npm publish` permanent;
  link reversible (`npm unlink` or another `npm link` on different checkout).

### Re-index when testing new functionality

`npm link` loads new JS, but **Qdrant index** is separate. Queries read
index-time payloads, so any change touching:

- payload signal descriptors (new `stats.confidence` block, new fields)
- payload builder / enrichment provider (new keys, renamed keys, value shape)
- migration pipelines (schema migration that hasn't run on current index)

requires re-indexing target project. Otherwise server runs new code but reads
old payloads — new paths see undefined fields / stale shape, silently behave as
before.

```bash
# Standard: incremental reindex (added + modified files only)
mcp__tea-rags__index_codebase project=<alias>
```

### Prefer the CLI when testing enrichments with reindex

Change touches **enrichment** + validating needs reindex → use CLI, NOT MCP
`index_codebase`:

```bash
tea-rags index-codebase --project <alias> --wait-enrichments --force --json
```

- `--wait-enrichments` stays attached until every provider finishes, renders
  per-provider bars + **durations** — enrichment timing free (perf-regression
  signal) + precise "done" marker.
- `--force` full re-index from scratch; drop for incremental.
- `--json` emits final result machine-readable (file counts, per-provider
  enrichment durations, `codegraphResolve` byReceiverKind) instead of human bars
  — parse directly. Always pass when agent consumes result.
- MCP `mcp__tea-rags__index_codebase` returns once embeddings stored,
  **detaches** enrichment to background — MCP-side testing forces polling
  `get_index_status` + guessing when enrichment settled. CLI's synchronous wait
  removes polling + guesswork.

### Schema drift — reindex from scratch (tea-rags self-test only)

Testing **new payload schema** on tea-rags project itself (`code_8b243ffe`):
existing index built by previous schema. Incremental reindex won't reset
unchanged-file payloads — schema-drift guard rejects run. Force full re-index:

```bash
mcp__tea-rags__force_reindex project=tea-rags    # explicit user confirmation required
```

Or via CLI: `tea-rags reindex --force /Users/artk0re/Dev/Tools/tea-rags-mcp`.

Only on tea-rags self-test index. Real user projects (`production-rails-app`,
etc.) wait for regular incremental migration — force reindex on large project =
hours, rarely right tool for testing unreleased changes.

### Test sequence when new functionality affects payload

```bash
# 1. Worktree: build + link + reindex tea-rags + (optionally production-rails-app)
cd .claude/worktrees/<branch>
npm run build
npm link
# → reconnect MCP servers
# enrichment-affecting change: prefer the CLI (synchronous + timed)
tea-rags index-codebase --project tea-rags --wait-enrichments --force --json   # full reset
mcp__tea-rags__index_codebase project=production-rails-app              # other projects: incremental

# 2. Validate via mcp__tea-rags__semantic_search / find_symbol against
#    the freshly indexed payload.

# 3. Merge. Do NOT relink main (parallel sessions own their own links).
#    Leave indices as-is (main's payload schema matches the worktree after merge).
```
