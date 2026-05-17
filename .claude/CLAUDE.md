# tea-rags — Project Rules

## Process Rules

- `.claude/rules/silo-pairing.md` — process rule for commits touching deep-silo
  files (must include `Why:` line).

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

**Stats vs Metrics rule.** Stats is the math of the distribution (compute /
persist layer). Metrics is its polished view for the user (DTO layer). The
builder runs in one direction only: `SignalStats` → `SignalMetrics` via
`buildSignalMetrics`. Never merge them under one name — they are two layers with
different responsibilities. New low-level aggregates (count, percentiles, mean,
stddev, etc.) go to `Stats` types. New user-facing fields exposed via MCP go to
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
| `migration`         | `infra/migration/`                               |
| `bootstrap`         | `bootstrap/`                                     |

### Design Principle: Don't Generate — Interrogate

The agent's instinct is to GENERATE variants fast and move on. The user's
strength is to INTERROGATE each variant until it breaks or holds.

**The anti-pattern that wastes time:**

1. Agent proposes "pure function renderOutline()" → user says it's wrong
2. Agent proposes "OutlineRenderer with strategies" → user says naming is wrong
3. Agent proposes "ChunkGroupView" → user says view doesn't reflect reality
4. Agent proposes "ChunkGrouper" → user approves

The agent went through 4 names because it generated instead of thinking. Each
time the user had to explain WHY it was wrong. The agent should have asked
itself: "what does this component DO?" → it groups chunks → ChunkGrouper. One
step, not four.

**Rule:** Before proposing a name or structure, answer three questions:

1. What does it DO? (verb → noun)
2. Who OWNS it? (domain)
3. What's the INTERFACE? (inputs/outputs)

If you can't answer all three — don't propose, investigate first.

**Why:** The user's time is more valuable than the agent's compute. Every bad
proposal the user has to reject is wasted human attention. Get it right in fewer
rounds.

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

When a pre-commit hook fails with
`ERROR: Coverage for <metric> (X%) does not meet global threshold (Y%)`, you
MUST delegate to the `coverage-expander` subagent rather than writing tests
inline. The agent is defined at `.claude/agents/coverage-expander.md` and is
optimized for this exact scenario:

- parses `coverage/coverage-summary.json` instead of grepping vitest stdout
- uses `mcp__tea-rags__find_symbol` / `hybrid_search` instead of `Read` for
  source discovery
- runs `vitest --coverage` at most 2× (3× with one retry) per invocation —
  hard-capped to keep latency bounded
- never modifies production code, configs, or thresholds; never adds `v8 ignore`
  / `eslint-disable`; never rewrites passing tests

Invoke it via the `Agent` tool with `subagent_type: "coverage-expander"`. Pass
the failing pre-commit output and (if relevant) which files the commit
introduced. The agent writes test files only — the parent session handles the
follow-up commit.

Do NOT use `coverage-expander` for unrelated coverage exploration or test
authoring outside a failing pre-commit hook — its early-exit clause stops it
when thresholds are already met.

## MCP Integration Testing — `npm link` workflow

The tea-rags MCP server registered in Claude Code uses the **globally-installed
npm package** (`npm i -g tea-rags-mcp`), NOT the local `build/` artifact in this
checkout. Local `npm run build` produces JS in `build/` but the running MCP
server keeps pointing at the global install. Without re-linking, MCP-side
integration tests via `mcp__tea-rags__*` tools cannot validate local changes —
they exercise whatever was published last.

### Sequence (worktree → merge → main link)

The link is **flipped twice** with a merge between. Skip neither step.

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

# 4. Main: build the merged code + re-link so global tea-rags reflects main.
npm run build
npm link

# 5. Reconnect MCP servers again. Subsequent sessions see merged content.
```

The reason step 4 happens AFTER the merge (not before, not skipped): the link in
step 1 pointed at the worktree's working tree. After the merge integrates the
worktree's commits into main, only main has the canonical post-merge state.
Re-linking main at step 4 makes the global tea-rags reflect what is actually
committed on main — not a stale worktree directory that may be removed or
evolved further.

### Why build AND link each time

- `npm link` registers the current `package.json` path as the source for the
  global symlink. It does NOT trigger a build — the consumer (MCP server) loads
  whatever `build/` happens to contain when it next starts.
- The `npm run build` step ensures `build/` reflects current source. Skipping it
  leaves the link pointing at stale compiled output.

### When to skip the link-flip entirely

- Pure docs / spec / plan changes that don't touch `src/` — no rebuild needed.
- Type-only changes that don't alter runtime behavior — local `npm test` covers
  the regression surface; MCP-side run gives the same result.

### Anti-patterns

- **Linking without building.** Leaves stale `build/` content under the link.
  Run `npm run build` first.
- **Building+linking main BEFORE merging.** Main's `build/` doesn't yet contain
  the worktree's changes. The global link will point at main's pre-merge state
  and MCP tests regress to the un-tested baseline.
- **Skipping the post-merge re-link.** Global tea-rags stays pinned to the
  worktree directory. If that worktree is removed (`git worktree remove`) the
  link breaks; if it evolves further, MCP exercises mismatched code.
- **Publishing instead of linking** as a quick test path. `npm publish` is
  permanent; the link is reversible (`npm unlink` or another `npm link` on a
  different checkout).

### Re-index when testing new functionality

`npm link` makes the MCP server load the new JS, but the **Qdrant index** is a
separate concern. Queries read payloads that were written at index time, so any
change that touches:

- payload signal descriptors (new `stats.confidence` block, new fields)
- payload builder / enrichment provider (new keys, renamed keys, value shape)
- migration pipelines (schema migration that hasn't run on current index)

requires re-indexing the project being tested against. Otherwise the MCP server
runs on new code but reads old payloads — the new code paths see undefined
fields or stale shape and silently behave as before.

```bash
# Standard: incremental reindex (added + modified files only)
mcp__tea-rags__index_codebase project=<alias>
```

### Schema drift — reindex from scratch (tea-rags self-test only)

When testing **new payload schema** on the tea-rags project itself
(`code_8b243ffe`), the existing index was built by the previous schema.
Incremental reindex won't reset payloads of unchanged files — the schema-drift
guard rejects the run. Force full re-index instead:

```bash
mcp__tea-rags__force_reindex project=tea-rags    # explicit user confirmation required
```

Or via CLI: `tea-rags reindex --force /Users/artk0re/Dev/Tools/tea-rags-mcp`.

Only do this on the tea-rags self-test index. For real user projects (`production-rails-app`,
etc.) wait for the regular incremental migration path — force reindex on a large
project is hours and is rarely the right tool for testing unreleased changes.

### Test sequence when new functionality affects payload

```bash
# 1. Worktree: build + link + reindex tea-rags + (optionally production-rails-app)
cd .claude/worktrees/<branch>
npm run build
npm link
# → reconnect MCP servers
mcp__tea-rags__force_reindex project=tea-rags   # schema drift: full reset
mcp__tea-rags__index_codebase project=production-rails-app    # other projects: incremental

# 2. Validate via mcp__tea-rags__semantic_search / find_symbol against
#    the freshly indexed payload.

# 3. Merge, build+link main, reconnect MCP, leave indices as-is
#    (master's payload schema should match worktree's after merge).
```
