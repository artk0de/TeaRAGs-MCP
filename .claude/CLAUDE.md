# tea-rags — Project Rules

npm package `tea-rags`, binary `tea-rags` — an MCP server for semantic code
search over a local Qdrant, with git/codegraph trajectories enriching the
payload and a reranker turning those signals into ranked answers. It ships both
an MCP tool surface (`src/mcp/`) and a CLI (`src/cli/`) over one core
(`src/core/`).

**This repo ships the search tooling, so use it on itself** — the self-index is
project alias `tea-rags` (collection `code_8b243ffe`). Which tool for which
intent is owned by `.claude-plugin/tea-rags/rules/search-cascade.md`; do not
reinvent that decision tree here.

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

`.claude/rules/` holds 37 path-scoped rule files — the loader surfaces the ones
whose `paths:` globs match what you touch, so do not enumerate them here. Read
`.claude/rules/plugin-guidance-layers.md` first: it defines the guidance layers
and which surface owns what.

Six declare `paths: ["**/*"]` and therefore bind every session:

- `naming.md` — qualify generic suffixes
  (`Outcome`/`Strategy`/`Metadata`/`Result`…) with domain context, unambiguous
  at use.
- `commit-rules.md` — commit types, scope-based versioning, `BREAKING CHANGE`
  footer.
- `epic-completion-gate.md` — build + `npm run test:coverage` + user-gated live
  validation before an epic closes.
- `worktree-beads-lifecycle.md` — tearing down a worktree (merge OR abandon)
  MUST first settle every bead the branch touched: close with evidence, reset to
  `open`, or hand to a named live worktree. Recover the bead set from
  `git log main..worktree-<name>` before removal.
- `session-completion.md` — landing the plane: issues, gates, push, handoff.
- `parallel-sessions.md` — concurrent sessions on one repo.

Two path-scoped ones are missed often enough to name here:

- `silo-pairing.md` — commits touching deep-silo files must include a `Why:`
  line.
- `domains-language.md` — Factory-encapsulates-construction, worker-thread DI
  via injected module-path, language-migration test rule (preserve examples,
  validate counts). Scoped `domains/language`, chunker, codegraph,
  `api/internal`, `contracts/types/language.ts`.

**`.claude/rules/.local/` is gitignored** (`.gitignore:28`), so it exists only
in the main checkout — a worktree session never sees `mcp-testing.md`,
`working-style.md`, `plan-beads-sync.md`, `beads-labels.md`. Anything a worktree
must obey belongs in a tracked rule, not there.

## Domain Navigators

Nested `CLAUDE.md` files auto-load when you touch their directory. They carry
local code-editing knowledge only — invariants held by convention, ordering
constraints, units, failure modes a green suite misses. Contract: a navigator
LINKS to a path-scoped rule, never restates it, and states each fact ONCE — a
fact two directories share belongs to their deepest common ancestor, a fact
another domain owns stays a pointer. (`.claude/rules/plugin-guidance-layers.md`
governs the four PLUGIN-facing layers — prime, tool schema, MCP resources,
search cascade — not these.)

| Navigator (under `src/core/`)         | What it briefs you on                                                   |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `domains/trajectory/`                 | derived-signal namespace, stats scoping, filter-preset compilation      |
| `domains/trajectory/git/`             | commit vs blame ownership families, walk windows, squash-aware sessions |
| `domains/trajectory/codegraph/`       | deferred chunk pass, physical-vs-alias DuckDB naming, logical keys      |
| `domains/ingest/`                     | quarantine store placement, what is quarantinable and what is not       |
| `domains/ingest/pipeline/`            | poison-pill isolation, process-vs-thread transports, ignore patterns    |
| `domains/ingest/pipeline/enrichment/` | payload-key scoping, terminal markers, run state, worker affinity       |
| `domains/ingest/operations/`          | incremental work set, alias-vs-target addressing, finalize order        |
| `domains/explore/`                    | read path: strategy → rerank → overlay/confidence                       |
| `domains/explore/strategies/`         | per-strategy post-processing contracts                                  |
| `domains/language/`                   | resolver-chain ordering, local bindings, deferral economics             |
| `domains/language/ruby/`              | Ruby walker/resolver/DSL specifics                                      |
| `domains/maintenance/`                | schema drift, migrations, freshness                                     |
| `domains/maintenance/registry/`       | sticky registry fields, CAS flush, env replay                           |
| `domains/maintenance/footprint/`      | the five per-collection artifacts, clone/remove saga                    |
| `domains/maintenance/worktree/`       | clone provisioning, saga commit point, teardown guard                   |

## Terminology (MANDATORY)

### Signal Taxonomy

| Term                             | Definition                                                                                                                                                          | Example                                                                                                                                                                   | Where                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Signal** (raw)                 | Value stored in Qdrant payload. Defined by Provider. Not normalized.                                                                                                | `ageDays=142`, `commitCount=23`, `bugFixRate=35`                                                                                                                          | `payload.git.{file,chunk}.*`, `payload.codegraph.symbols.{file,chunk}.*`                                                             |
| **Derived Signal**               | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets.                                       | `recency` (from ageDays), `ownership` (from blameDominantAuthorPct+blameAuthors)                                                                                          | `DerivedSignalDescriptor` in provider                                                                                                |
| **Structural Signal**            | Derived signal computed from payload structure alone — no history, no graph. Owned by the **static trajectory**, not by the Reranker.                               | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk`                                                                                                         | `domains/trajectory/static/rerank/derived-signals/`                                                                                  |
| **Preset** (`RerankPreset`)      | Class with name, description, tools[], weights, overlayMask; optional groupBy, signalLevel, filter. 2-level hierarchy: registry -> composite.                       | `class TechDebtPreset { tools: ["semantic_search","hybrid_search","rank_chunks","find_similar"], weights: {...}, overlayMask: {...}, filter: { presets: "production" } }` | `trajectory/{git,static}/rerank/presets/`, `trajectory/composite/presets/`, `trajectory/codegraph/symbols/rerank/presets/`           |
| **Overlay Mask** (`OverlayMask`) | Curates which **raw** signals appear in ranking overlay for a preset. `{ file?: string[]; chunk?: string[] }` — raw signal names only, no derived.                  | `{ file: ["ageDays", "commitCount"], chunk: ["bugFixRate"] }`                                                                                                             | Each preset class                                                                                                                    |
| **Ranking Overlay**              | Raw file/chunk signals selected by the preset's OverlayMask (or weight keys for custom), each as `{value,label}`, attached as `rankingOverlay`. No derived signals. | `{ preset: "techDebt", file: { commitCount: { value: 12, label: "high" } } }`                                                                                             | Reranker response                                                                                                                    |
| **Stats**                        | Low-level descriptive statistics over the collection: count/min/max/mean/stddev/percentiles. Internal compute artifact, not for direct user consumption.            | `count`, `mean`, `percentiles[25..95]`                                                                                                                                    | `SignalStats` in `contracts/types/trajectory.ts`, `StatsCache` in `infra/stats-cache.ts`, `domains/ingest/infra/collection-stats.ts` |
| **Metrics**                      | Consumer-facing aggregated frame built ON TOP of Stats — selects fields and attaches labels for the `get_index_metrics` MCP tool.                                   | `{ min, max, mean, count, labelMap }`                                                                                                                                     | `SignalMetrics` / `IndexMetrics` in `api/public/dto/metrics.ts`, built by `IndexMetricsQuery#buildSignalMetrics`                     |

**Stats vs Metrics rule.** Stats = distribution math (compute/persist layer).
Metrics = polished user view (DTO layer). Builder one-directional: `SignalStats`
→ `SignalMetrics` via `buildSignalMetrics`. Never merge under one name — two
layers, different responsibilities. New low-level aggregates (count,
percentiles, mean, stddev) → `Stats` types. New user-facing MCP-exposed fields →
`Metrics` DTOs.

### Domain Terms

| Term                 | Meaning                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider             | Trajectory that defines signals, derived signals, filters, and builds signal data.                                                                                                      |
| Filter               | Qdrant filter condition builder. Defined by Provider.                                                                                                                                   |
| Reranker             | Orchestrates derived signal extraction, adaptive bounds, scoring, and ranking overlay. Receives derived signals, resolved presets, payload signal descriptors and signal floors via DI. |
| SchemaBuilder        | Generates Zod schemas for MCP tools from Reranker's public API (DIP). Lives in api/.                                                                                                    |
| Alpha-blending       | L3 confidence-weighted blending of file vs chunk signals: `effective = alpha * chunk + (1-alpha) * file`.                                                                               |
| Confidence dampening | Quadratic per-signal dampening for unreliable statistical signals: `(n/k)^2` where k is signal-specific threshold.                                                                      |
| Adaptive bounds      | Per-query p95 over the result batch, floored with the collection p95. `defaultBound` applies only when collection stats are unloaded.                                                   |

### Path Shortcuts

All paths relative to `src/core/`, with one exception marked below.

| Alias               | Path                                                        |
| ------------------- | ----------------------------------------------------------- |
| `api-public`        | `api/public/`                                               |
| `api-internal`      | `api/internal/`                                             |
| `api-facades`       | `api/internal/facades/`                                     |
| `api-ops`           | `api/internal/ops/`                                         |
| `dto`               | `api/public/dto/`                                           |
| `explore`           | `domains/explore/`                                          |
| `explore-strats`    | `domains/explore/strategies/`                               |
| `explore-queries`   | `domains/explore/queries/`                                  |
| `chunk-grouping`    | `domains/explore/chunk-grouping/`                           |
| `preset-resolver`   | `domains/explore/rerank/presets/` (resolver only)           |
| `ingest`            | `domains/ingest/`                                           |
| `ingest-ops`        | `domains/ingest/operations/`                                |
| `ingest-infra`      | `domains/ingest/infra/`                                     |
| `pipeline`          | `domains/ingest/pipeline/`                                  |
| `chunker`           | `domains/ingest/pipeline/chunker/`                          |
| `enrichment`        | `domains/ingest/pipeline/enrichment/`                       |
| `sync`              | `domains/ingest/sync/`                                      |
| `language`          | `domains/language/`                                         |
| `lang-chunking`     | `domains/language/<lang>/chunking/`                         |
| `lang-kernel`       | `domains/language/kernel/`                                  |
| `traj-git`          | `domains/trajectory/git/`                                   |
| `traj-git-signals`  | `domains/trajectory/git/rerank/derived-signals/`            |
| `traj-git-presets`  | `domains/trajectory/git/rerank/presets/`                    |
| `traj-git-stats`    | `domains/trajectory/git/stats/`                             |
| `traj-static`       | `domains/trajectory/static/`                                |
| `traj-static-stats` | `domains/trajectory/static/stats/`                          |
| `traj-codegraph`    | `domains/trajectory/codegraph/symbols/`                     |
| `traj-composite`    | `domains/trajectory/composite/`                             |
| `traj-filters`      | `domains/trajectory/filter-presets/`                        |
| `maint-registry`    | `domains/maintenance/registry/`                             |
| `maint-footprint`   | `domains/maintenance/footprint/`                            |
| `maint-worktree`    | `domains/maintenance/worktree/`                             |
| `maint-freshness`   | `domains/maintenance/freshness/`                            |
| `migration`         | `domains/maintenance/migration/`                            |
| `contracts`         | `contracts/`                                                |
| `infra`             | `infra/`                                                    |
| `bootstrap`         | **`src/bootstrap/`** — sibling of `src/core/`, not under it |

Per-trajectory filter presets live at
`domains/trajectory/{git,static,composite,codegraph/symbols}/filter-presets/`.

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
- `GitFileSignals` / `ChunkChurnOverlay` (NOT GitFileMetadata) — the git
  trajectory's file and chunk payload types
- In the git trajectory: `computeFileSignals` / `computeChunkSignals` (NOT
  computeFileMetadata/computeChunkOverlay). The ban is trajectory-scoped —
  `Synchronizer#computeFileMetadata` legitimately owns sync `FileMetadata`
  (hash/mtime), a different concern.
- `fileSignalTransform` (NOT fileTransform)
- `PayloadSignalDescriptor` (NOT FieldDoc, NOT a bare `Signal` type)
- Provider payload descriptors are declared as
  `signals: PayloadSignalDescriptor[]` — provider-agnostic, never prefixed per
  trajectory

## Automation Agents

### coverage-expander (MANDATORY when commit fails coverage threshold)

Pre-commit fails
`ERROR: Coverage for <metric> (X%) does not meet global threshold (Y%)` → MUST
delegate to `coverage-expander` subagent, not inline tests. The subagent is
registered globally at `~/.claude/agents/coverage-expander.md` (the
project-local duplicate was deleted in `6e07f63c`); its methodology lives in the
agent-only `expand-coverage` skill (`.claude/skills/expand-coverage/`,
`user-invocable: false`) — freshness gate, hit-map corner-case discovery, run
caps, and the never-modify list all live there. Do not restate them here.

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
package** (`npm i -g tea-rags` — the package was renamed from `tea-rags-mcp` in
`13449f74`), NOT local `build/`. Local `npm run build` produces `build/` JS but
running server keeps pointing at global install. Without re-linking, MCP-side
integration tests via `mcp__tea-rags__*` exercise last-published, not local
changes.

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
  fresh worktree has no `build/`, and the chunker pool forks the _compiled_
  worker, so every worker-forking test — and therefore pre-commit — fails until
  the worktree is built once. Build it, don't link it. (Tracked as
  `tea-rags-mcp-hyj9d`; the mechanism is owned by
  `src/core/domains/ingest/pipeline/CLAUDE.md`.)
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
before. Which collaborator may write which payload key is owned by
`src/core/domains/ingest/pipeline/enrichment/CLAUDE.md`.

```bash
# Standard: incremental reindex (added + modified files only)
mcp__tea-rags__index_codebase project=<alias>
```

### Prefer the CLI when testing enrichments with reindex

Change touches **enrichment** + validating needs reindex → use CLI, NOT MCP
`index_codebase`:

```bash
DEBUG=1 tea-rags index-codebase --project <alias> --wait-enrichments --force --json
```

- `--wait-enrichments` stays attached until every provider finishes, renders
  per-provider bars + **durations** — enrichment timing free (perf-regression
  signal) + precise "done" marker.
- `--force` full re-index from scratch; drop for incremental.
- `--json` emits the final result machine-readable — file counts, phase
  durations, `outcome.failed` / `outcome.degraded`, `infraHealth`,
  `enrichmentHealth` — instead of human bars. Parse directly. Always pass when
  an agent consumes the result.
- **`--json` does NOT carry the codegraph resolve breakdown**, and neither does
  the MCP `get_index_status` formatter or the pipeline debug log.
  `resolveSuccessRate` per receiver kind is rendered by **`prime`**, under
  `## Codegraph resolve`:

  ```bash
  DEBUG=1 tea-rags prime <path>   # bareCall 0.93 7816/15114, dynamic 0.88 …
  ```

  It reads the `cg_run_stats` the last index run persisted, so run the index
  first and prime after. That is the only supported read path for the
  **persisted per-receiverKind rates** — querying DuckDB directly is not one.
  (The core DTO does carry `codegraphResolve`; only the MCP formatter drops it.)
  Measuring a RESOLVER change needs no index run at all — the offline harnesses
  and their preconditions are owned by `src/core/domains/language/CLAUDE.md`.

- Do not pipe a `--json` run through `head`/`tail` when you also want the
  diagnostics: they share the stream, and the truncation silently drops the half
  you were not looking at.
- MCP `mcp__tea-rags__index_codebase` returns once embeddings stored,
  **detaches** enrichment to background — MCP-side testing forces polling
  `get_index_status` + guessing when enrichment settled. CLI's synchronous wait
  removes polling + guesswork.

### Schema drift — reindex from scratch (tea-rags self-test only)

Testing **new payload schema** on tea-rags project itself (`code_8b243ffe`): the
drift guard compares the current composition's payload descriptor keys against
the keys the cached index recorded, and an incremental reindex won't reset
unchanged-file payloads — so the run is rejected. A trajectory flag flip
produces the same report with zero schema change; the mechanism is owned by
`src/core/domains/maintenance/CLAUDE.md`. Force full re-index:

```bash
# MCP: forcing is a PARAMETER, not a separate tool
mcp__tea-rags__index_codebase project=tea-rags forceReindex=true   # explicit user confirmation required

# CLI (preferred — synchronous + timed):
DEBUG=1 tea-rags index-codebase --project tea-rags --force --wait-enrichments --json
```

Only on the tea-rags self-test index. Real user projects (`taxdome`, etc.) wait
for regular incremental migration — force reindex on a large project = hours,
rarely the right tool for testing unreleased changes.

### Test sequence when new functionality affects payload

```bash
# 1. Worktree: build + link + reindex tea-rags + (optionally another project)
cd .claude/worktrees/<branch>
npm run build
npm link
# → reconnect MCP servers
# enrichment-affecting change: prefer the CLI (synchronous + timed)
DEBUG=1 tea-rags index-codebase --project tea-rags --wait-enrichments --force --json   # full reset
mcp__tea-rags__index_codebase project=<other-project-alias>             # other projects: incremental

# 2. Validate via mcp__tea-rags__semantic_search / find_symbol against
#    the freshly indexed payload.

# 3. Merge. Do NOT relink main (parallel sessions own their own links).
#    Leave indices as-is (main's payload schema matches the worktree after merge).
```
