# Private-corpus navigation benchmark: Claude Code with and without TeaRAGs — design

Date: 2026-10-09. Supersedes the SWE-bench line
(`2026-10-03-swe-bench-lite-ab-design.md`) as the efficiency benchmark; that
harness stays as the code base this one reuses.

## Question

On which tasks does TeaRAGs make an agent cheaper and faster at finding the code
a change needs — and does it add anything over hand-written navigators
(`CLAUDE.md` chain, `docs/`, domain maps), or replace them?

The quantity under test is the cost of acquiring code context: tokens, tool
calls, wall clock. Not resolve rate, not embedding recall.

Prior (operator's transcript study, 2026-10-06, not a benchmark): with TeaRAGs
the agent makes ~75% fewer tool calls and up to ~80% fewer input tokens on real
tasks. Phase 1 tests that claim.

## Why not SWE-bench

Measured on Lite, rebench and Pro (2026-10-05..06):

- Arm 1 made **0** TeaRAGs calls on every smoke task. The model either knew the
  layout or grepped identifiers from the issue in 1–2 calls.
- Memorisation probe (`claude -p`, no tools, issue text only → gold path):
  file-level hits on ansible, element-web, webclients; directory-level on
  openlibrary, qutebrowser. In Pro, 210 of 348 issues name a gold file.
- The one measured cost delta went the other way (django-11910: $0.18 vs $0.059,
  identical patches) — tool-schema context with no navigation to pay it back.

A private corpus the model never trained on removes memorisation by
construction. TaxDome (Rails 8 + React/TS monolith, ~31k indexed files) is the
first corpus; the harness takes any git repository with a ticket tracker.

## Phases

| Phase | Protocol                                                                                         | Primary metrics                                                                            | Status                     |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------------------- |
| 1     | localization-only: read the ticket, name the files and symbols to change, stop. Edits forbidden. | tokens, tool calls, solve time                                                             | this design                |
| 2     | full solve: edits allowed                                                                        | phase-1 metrics measured inside implementation, blast-radius recall, guardrail on the diff | later, same task manifests |

Phase 1 isolates the navigation share of the cost; phase 2 measures TeaRAGs
during development itself and uses phase 1 as the baseline for how much of a
solve is localization.

## Cells: 2×2

|                         | Navigators stripped | Navigators present |
| ----------------------- | ------------------- | ------------------ |
| **TeaRAGs off** (arm 0) | A                   | B                  |
| **TeaRAGs on** (arm 1)  | C                   | D                  |

- C−A: TeaRAGs alone. D−B: TeaRAGs on top of navigators. C−B: can TeaRAGs
  replace navigators. B−A: what navigators are worth by themselves.
- **Amendment 2026-10-26 (naming): from here on there are two cells, both with
  navigators stripped. A = TeaRAGs on (the pilot's C), B = TeaRAGs off (the
  pilot's A).** No cell runs with navigators. Pilot data is stored under the new
  letters. The pilot's own B and D runs (navigators present) are archived
  separately.
- **Amendment 2026-10-26: runs after the 3-task pilot use only the
  navigator-stripped cells (pilot letters A and C).**
  Navigators are not treated as a free baseline: someone has to research the
  code and spend tokens to write them, and they decay — 8–18% of the path
  references in `CLAUDE.md` at the pilot bases pointed at files that no longer
  existed (9.8% on master). Cells B and D stay in the pilot record, and the B/D
  checkout code stays in the harness.
- Common to all cells: Claude Code headless (`claude -p`), `claude-sonnet-5-5`,
  isolated empty `CLAUDE_CONFIG_DIR`, `--strict-mcp-config`, identical prompt,
  same timeout and max turns. Arm 1 adds the TeaRAGs MCP server and plugin, the
  way they ship — no forced first call, no hook that blocks reads. Adoption is
  measured, not induced (gate below).
- **Navigators** are defined per project in the profile as a glob list. For
  TaxDome: every `CLAUDE.md` (root `.claude/CLAUDE.md`, `app/**/CLAUDE.md`),
  `docs/**`, `.claude/rules/domain-docs.md`,
  `.claude/rules/.local/domain-structure.md`.
  - _stripped_: these files are deleted from the task checkout **and** excluded
    from the TeaRAGs index (a `.contextignore` built from the same globs).
    Otherwise arm 1 would read the navigators through search.
  - _present_: kept in the checkout and the index.
- **Process instructions** are removed in every cell: `.claude/skills`,
  `.claude/agents`, `.claude/commands`, hooks, `settings*.json`, and rules that
  govern workflow rather than code location (review gates, branch naming, commit
  rules, test-runner wiring). They change agent behaviour without being
  navigation and would add noise to every cell.

## Task manifest (project-agnostic)

One JSON record per task; the harness never reads project code to build it.

```json
{
  "id": "taxdome-<sha8>",
  "repo": "/abs/path/to/source/repo",
  "base_sha": "<first parent of the merge>",
  "merge_sha": "<merge commit>",
  "ticket": { "key": "TD-12345", "type": "Bug", "title": "...", "body": "..." },
  "gold_files": ["app/services/..."],
  "gold_symbols": ["Foo::Bar#call"],
  "stratum": "small|medium|large",
  "covariates": {
    "pointing": "not-named",
    "named_frac": 0.0,
    "doc_frac": 0.2,
    "lexical_overlap": 0.12,
    "languages": ["ruby"],
    "layers": 2,
    "changed_lines": 34
  }
}
```

Manifests, ticket text, gold diffs and transcripts are **private** — they live
outside both repositories (`~/Dev/bench-private/<project>/`). Only the harness,
the profile template and anonymised reports are committed here.

## Task mining

Adapter interface per project: `list_merges(window)`, `ticket(key)`,
`navigator_globs`, `process_globs`, `exclude_from_gold`.

1. **Candidates.** Merge commits into the main branch in the last 6 months whose
   branch name carries a ticket key (`TD-\d+`). Gold diff = `merge^1..merge`.
2. **Gold.** Changed files minus `exclude_from_gold` (TaxDome: `spec/**`,
   `*_spec.rb`, `*.test.ts(x)`, `config/locales/**`, `db/schema.rb`, generated
   API clients, swagger output, lockfiles). Gold symbols = the innermost method
   / class enclosing each hunk, via tree-sitter. Localization gold = gold files
   that exist at `base_sha`; files the merge adds are kept apart as `gold_added`
   (an agent cannot find a file that does not exist yet). Tasks where added
   files are more than half of the gold are dropped — they are writing new code,
   not finding existing code.
3. **Drop.** Reverts, dependency bumps, migrations-only diffs, mechanical sweeps
   (> 40 gold files), gold entirely under `config/` (flag toggles), gold with no
   file under `app/` or `lib/` (tooling), tickets with more than one MR in the
   window, ticket bodies under 120 characters.
4. **Named / doc-pointed, per gold file.** A gold file is _named_ when a token
   that points at it appears in the ticket text, and _doc-pointed_ when such a
   token appears in a navigator file at `base_sha`. Pointing tokens: the path, a
   namespaced constant camelised from the path (`Proposals::Update`), a
   multi-word CamelCase or snake_case basename, a hunk symbol of the same shape.
   Single common words (`Client`, `Filters`) do not count. Per task:
   `named_frac` and `doc_frac` = share of existing gold files named /
   doc-pointed.
5. **Strata — two axes.**
   - Size (non-test gold): small — bugfix branch prefix, 1–2 files, ≤ 40 changed
     lines; medium — 3–6 files or 41–300 lines; large — ≥ 7 files and > 300
     lines.
   - Pointing: _not-named_ — `named_frac` ≤ 0.34 and `doc_frac` ≤ 0.34; _named_
     — everything else.
6. **Sample.** Seeded draw per size stratum, ~5 candidates per size × pointing
   cell → operator vetoes (unclear ticket, MR mixing several changes, gold that
   is not the real fix) → 3 per cell for the pilot. The veto log is kept with
   the reason per rejected task.

Why pointing is an axis and not a filter: on the first 60 seeded TaxDome
candidates the strict rule (no gold file named or doc-pointed) kept 2. 44 of the
60 tickets are developer-written technical breakdowns (`TBD`) that list classes
and paths; in a large diff some gold file is always mentioned in some
`CLAUDE.md`. Named tickets are the normal case here, not leakage. The two cells
measure different things: on not-named tasks TeaRAGs pays for search; on named
tasks the location is given and the saving, if any, comes from addressed reads
(`find_symbol` instead of whole-file `Read`) and from finding the gold files the
ticket did not name.

## Task repositories and indexes

- One standalone repo under `/Users/Shared/nav-ab/repo` (no ancestor
  `CLAUDE.md`), reused for every task: per task its `.git` is recreated
  (`git init` + an `alternates` file pointing at the source object store,
  `core.logAllRefUpdates false`), `HEAD` set to `base_sha`, and one `snapshot`
  commit dated at the base removes the process files. No ref, reflog or earlier
  snapshot reaches a later commit. The _stripped_ condition amends that commit
  to also remove the navigators; the base commit below it still holds them
  (`git show HEAD~1:<path>`), an accepted residual.
- One TeaRAGs index: a `worktree create --from <project>` clone of the project's
  live index, synced to each task's tree incrementally and then rebuilt with
  `--force-enrichments git,codegraph` against the repo's truncated history, so
  no git signal (`taskIds`, churn, ages) sees a commit after `base_sha`. Tasks
  run newest base first. Present cells run first; the stripped condition is an
  incremental sync of the deletions, no enrichment rebuild. Pilot cost on
  TaxDome (32k files, local embedder): 64 min sync + 20 min rebuild for the
  first task (39.9k files changed since the live index), ~38 + 10–15 min for
  each later one.
- The clone inherits the source project's registry env; a residual-resolution
  URL that is down leaves codegraph `degraded` (static edges only). The pilot
  ran that way. From 2026-10-26 the harness unsets
  `CODEGRAPH_RESIDUAL_KEV_SESSION_URL` on the clone right after `worktree
  create`: residual resolution is not part of the benchmark.
- Index scope (from 2026-10-26): `.contextignore` is the repo's own file, and
  `.contextignore.local` is the operator's daily TaxDome scope plus `*.md`,
  `*.txt`, `*.csv` and `*.xml`. The daily scope already drops yml/json/css,
  generated code, prototypes, `db/**`, `public/**` and swagger schemas; the
  pilot clone was synced without it. The harness copies the file into the repo
  after `git clean`, and git ignores it. Specs stay indexed: the operator's
  daily index has them, and both arms see the same checkout. Only the index
  scope differs.
- Index time is reported descriptively and never added to solve time.

### Run pre-flight

- A task base can pin its own Node (`.nvmrc` / `.node-version`); asdf/nvm then
  start the TeaRAGs server under it and its native modules fail silently
  (TaxDome April 2026: v22.1.0). The runner pins the interpreter for the agent
  process (`ASDF_NODEJS_VERSION`) in every cell.
- An arm-1 run whose `system/init` event does not report `tea-rags: connected`
  is invalid and is re-run, not scored (`mcp_failed`).

## Prompt (phase 1)

Fixed text, identical in all cells: the ticket title and body, the repository
path, and: "Find where this change must be made. Do not edit files. When done,
answer with one JSON object `{files: [...], symbols: [...], rationale}` listing
the files and the methods/classes that need to change, and stop." `Edit`,
`Write` and `NotebookEdit` are disallowed by flag.

## Metrics

| ID  | Group        | Metric                                                                                                                                                                                                                                                                                       | Role          |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| M4  | Cost         | input, cache write, cache read, output tokens; `total_cost_usd`; **peak context** (max per-turn input+cache) ; **fixed overhead** = first-turn input (system prompt + tool schemas) reported apart from the variable part; tool-output tokens per tool class (search / read / graph / shell) | **primary**   |
| M5  | Speed        | solve wall clock without in-run reindex; turns; tool calls total and per tool                                                                                                                                                                                                                | **primary**   |
| M1  | Localization | recall and precision of the answer vs gold files and gold symbols; turns / tokens / seconds until the first read of a gold file                                                                                                                                                              | guardrail     |
| M2  | Read economy | lines returned by `Read` (whole vs offset) vs `find_symbol`; repeated reads of one file; share of non-gold files read                                                                                                                                                                        | diagnostic    |
| M3  | Graph        | `get_callers` / `get_callees` / `trace_path` calls                                                                                                                                                                                                                                           | diagnostic    |
| M6  | Adoption     | TeaRAGs calls / all search+read calls (arm 1)                                                                                                                                                                                                                                                | gate          |
| P   | Memorisation | probe hit rate (no tools, ticket → gold path)                                                                                                                                                                                                                                                | premise check |

Rules:

- **Gate.** A cell-C/D run with M6 < 0.3 is flagged; the C−A and D−B deltas are
  reported with and without flagged pairs.
- **Guardrail.** A cost win counts only next to its recall: the report shows ΔM4
  / ΔM5 together with ΔM1 per pair, and splits pairs where arm 1 is cheaper but
  found fewer gold files.
- **Overhead.** Fixed overhead is a constant per arm; the variable part is where
  navigation savings show. The break-even task size (where variable savings
  exceed the overhead) is a reported result, not noise.

## Covariates — "on which tasks"

Per task: size stratum, pointing stratum, `named_frac`, `doc_frac`, lexical
overlap (ticket tokens vs gold identifiers), layers crossed (model / service /
controller / frontend), language mix, gold file count. The analysis regresses
the paired delta on these; with 18 tasks it is descriptive, at 36 it starts to
discriminate.

## Pilot and later runs

1. Pilot: 3 sizes × 2 pointing × 3 tasks = 18 tasks × 4 cells × 1 run = 72 runs.
   Cell order randomised per task (seed 20261009).
2. Repetitions: 2 more runs per cell on the same 18 tasks (216 total).
3. Expansion: 6 per size × pointing cell (36 tasks), same plan.

Each step is pre-registered in `evals/agent-nav-ab/PREREGISTRATION.md` before it
runs.

## Publication

The harness is open ("bring your own repo"). Results from a private corpus are
published as: per-task table with hashed task ids, stratum, covariates and all
metrics per cell; corpus description without code (LOC, files, languages, age,
commit count); redacted tool-call sequences with hashed paths. Raw transcripts
and manifests stay private.

## Location and reuse

`evals/agent-nav-ab/` (uv, Python), not shipped in the npm package. Reused from
`evals/swe-bench-lite/src/swe_lite_ab/`: `agent` (isolated runner), `transcript`
(stream-json metrics), `stats` (Wilcoxon, McNemar, bootstrap), `repos`
(instruction-leak guard), `indexing` (seed chain), `probe` (memorisation),
`localize` (recall / MRR). New: `mine` (adapter + filters + strata), `profile`
(navigator / process globs, gold exclusions), `cells` (2×2 checkout and index
preparation), `answer` (final-JSON parsing and scoring), report sections for
M2–M6 and the overhead split.

## Out of scope

- Resolve rate and test oracles (phase 2 guardrail only).
- Forced TeaRAGs usage or read-blocking hooks.
- Public-corpus companion runs.
