# tea-rags — Project Rules

## Terminology (MANDATORY)

### Signal Taxonomy

| Term                             | Definition                                                                                                                                       | Example                                                                                   | Where                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Signal** (raw)                 | Value stored in Qdrant payload. Defined by Provider. Not normalized.                                                                             | `ageDays=142`, `commitCount=23`, `bugFixRate=35`                                          | `payload.git.file.*`, `payload.git.chunk.*`                 |
| **Derived Signal**               | Normalized/transformed value computed from one or more raw signals at rerank time. Range 0-1. Used as weight keys in presets.                    | `recency` (from ageDays), `ownership` (from blameDominantAuthorPct+blameAuthors)          | `DerivedSignalDescriptor` in provider                       |
| **Structural Signal**            | Derived signal from payload structure, not from any trajectory provider.                                                                         | `similarity`, `chunkSize`, `documentation`, `imports`, `pathRisk`                         | Reranker built-in                                           |
| **Preset** (`RerankPreset`)      | Class with name, description, tools[], weights, overlayMask. 3-level hierarchy: Generic -> Trajectory -> Composite. Each preset is a class file. | `class TechDebtPreset { tools: ["semantic_search"], weights: {...}, overlayMask: {...} }` | `trajectory/git/rerank/presets/`, `explore/rerank/presets/` |
| **Overlay Mask** (`OverlayMask`) | Curates which signals appear in ranking overlay for a preset. `derived: string[]` + optional `raw: { file?, chunk? }`.                           | `{ derived: ["age", "churn"], raw: { file: ["ageDays"] } }`                               | Each preset class                                           |
| **Ranking Overlay**              | Subset of raw + derived signals filtered by OverlayMask (or weight keys for custom), attached to each reranked result.                           | `{ raw: { file: { ageDays: 142 } }, derived: { recency: 0.61 } }`                         | Reranker response                                           |

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
they exercise whatever the global install was when last published.

### Worktree → master link-flip

When testing a build that lives in a worktree branch:

```bash
# 1. In the worktree: build + link the local checkout as the global tea-rags
npm run build
npm link

# 2. Reconnect MCP servers in Claude Code (deferred-tools refresh).
#    Then mcp__tea-rags__* tools exercise the worktree build.

# 3. After validation (or before switching back to main work), restore master
cd /Users/artk0re/Dev/Tools/tea-rags-mcp     # main checkout
npm run build
npm link

# 4. Reconnect MCP servers again.
```

### Why both `npm run build` AND `npm link`

- `npm link` registers the current `package.json` path as the source for the
  global symlink. It does NOT trigger a build — the consumer (MCP server) will
  load whatever `build/` happens to contain when it next starts.
- The `npm run build` step ensures `build/` reflects current source. Skipping it
  leaves the link pointing at stale compiled output.

### When to skip the link-flip

- Pure docs / spec / plan changes that don't touch `src/` — no rebuild needed.
- Type-only changes that don't alter runtime behavior — local `npm test` is
  enough; MCP-side run gives the same result.
- Anything in worktree branch that hasn't been built yet — `npm link` without a
  fresh `build/` exposes stale JS.

### Anti-patterns

- **Linking without building.** Leaves stale `build/` content under the link.
  Run `npm run build` first.
- **Forgetting to re-link on master.** Subsequent sessions in main checkout
  exercise the worktree's stale `build/` until master's `npm link` overwrites.
- **Publishing instead of linking** as a quick test path. `npm publish` is
  permanent; the link is reversible (`npm unlink` or another `npm link` on a
  different checkout).
