# Codegraph Residual Resolution — model-assisted edges over the static resolver

> Status: Design (approved 2026-10-09). Topic owner: codegraph trajectory.
> Scope: wave 1 = Kev provider, ambiguous + dynamic-receiver call sites.
> Supersedes the delivery path of `2026-05-27-codegraph-sink-edges-design.md`
> (never implemented); its gap taxonomy is reused in wave 2.

## Problem

The static resolver drops a call edge rather than guess. On taxdome that leaves
a residual of ~8k ambiguous sites (two or more namesake targets) and ~27.5k
dynamic-receiver sites (a parameter, ivar or call result with no type evidence)
— about 13.3k model questions after grouping. `get_callers`, `trace_path`, fanIn
and PageRank are a lower bound wherever that residual sits.

A local model can close most of it. Measured 2026-10-09 on 91 YARD-labelled
receiver questions (menus of ~34 classes, method source only):

| Model                              | all   | naming-miss (n=31) | naming-hit (n=60) |
| ---------------------------------- | ----- | ------------------ | ----------------- |
| Kev 4B (`jaredpalmer/kev-4b@v1.0`) | 0.945 | 0.839              | 1.000             |
| Claude Haiku 4.5                   | 0.989 | 0.968              | 1.000             |

Kev's row is the design-time run; the recorded run vendored as the eval baseline
(`tests/fixtures/residual-eval/baseline-kev.json`) scores 0.934 / 0.806 / 1.000.
Every Kev error had `p ≤ 0.503`; at `p ≥ 0.7` Kev's precision was 1.00 (70/70).
Kev on a local RX 7800M serves ~13 q/s, so the full taxdome residual takes ~19
minutes. A cloud model on the full residual costs ~20–40M tokens, which eats a
subscription's 5-hour or weekly limit. The subsystem is therefore local-first:
Kev is the reference provider, cloud providers are optional.

## Decisions

1. **Separate pass, never inside `resolve`.** Indexing never waits on a model.
   The pass reads a residual table the static resolver writes, and its verdicts
   are cached across runs.
2. **Entry points.** `tea-rags resolve-codegraph-residual --model=kev` runs the
   pass alone. `tea-rags index-codebase --resolve-residual=kev` runs it as the
   last phase of indexing, strictly after embeddings. The pass reports a
   `resolving-residual` phase through `ProgressUpdate`; the CLI renderer and an
   external GUI show it as its own progress bar (there is no GUI in this repo).
3. **Only confident verdicts become edges.** A verdict with `p` at or above the
   provider's threshold (Kev default 0.7) becomes an edge marked
   `origin: "model"`; lower verdicts stay in the verdict store only.
4. **Wave 1 residual = ambiguous + dynamic receiver.** Metaprogramming gaps
   (`send(var)`, `method_missing`, `define_method(var)`, `const_get(var)`,
   `eval` family — the sink-edges taxonomy) are wave 2: they need walker
   branches and a different question shape.
5. **Wave 1 provider = Kev.** Jev, `claude-haiku` (Anthropic API, key) and
   `claude-haiku-cli` (headless `claude -p --model haiku`, subscription) are
   wave 2. The provider port is fixed in wave 1 so they plug in without core
   changes.
6. **Verdicts outlive the index.** They are kept in their own store, survive
   `--force` and `--force-enrichments`, expire by retention (default 180 days),
   and are deleted only when the project or index is deleted. They double as a
   training corpus.

## Data model

### `residual_call_sites` — in the generation's graph DB

Captured on the production resolve path (`CallEdgeResolutionRunner`'s
`judgeCallSite` verdicts, the same ones `callSiteVerdicts` exposes) through a
thin sink, and reconciled per source file exactly like the edge tables
(`DuckDbFileGraphStore#writeFileRowsGroup`): a re-walked file replaces its
slice, an unchanged file keeps it. A site is residual when its verdict is
`outcome: "ambiguous"` (`kind = ambiguous`), or `outcome: "unresolved"` with
`missBucket = "missWithInProjectDef"` on a `dynamic`, `ivar` or `chain` receiver
(`kind = dynamic`). A site with an empty menu is not recorded.

| Column                                 | Meaning                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `site_key`                             | hash of rel path, enclosing method symbolId, call position, receiver text, member |
| `source_rel_path`                      | file of the call site                                                             |
| `method_symbol_id`                     | enclosing method                                                                  |
| `method_start_line`, `method_end_line` | span of the enclosing method; the pass reads its source from disk                 |
| `line`, `column`                       | call position                                                                     |
| `receiver_text`, `member`              | the call as written                                                               |
| `kind`                                 | `ambiguous` \| `dynamic`                                                          |
| `candidates`                           | candidate target method symbolIds (`Class#member`)                                |
| `menu_hash`                            | hash of the sorted candidate list                                                 |
| `menu_overflow`                        | the candidate list was cut at the menu limit                                      |

The menu is built the same way for both kinds, from
`GlobalSymbolTable#lookupByShortName(member)`: method ids ending in `#member` or
`.member`, defined in a file with the call site's extension, deduplicated and
sorted. `cg_ambiguous_fanout` cannot supply it — it stores only
`candidateCount`, not the candidate ids.

Menus are capped at `CODEGRAPH_RESIDUAL_MENU_LIMIT` (default 40, the size the
eval measured). A site whose menu is larger (`id`, `firm` on a Rails app) is
written with `menu_overflow = true` and skipped by the pass in wave 1: a model
choosing among hundreds of classes was never measured.

### Verdict store — its own DuckDB file, keyed by base collection

`<rootDir>/residual-verdicts/<logicalName>.duckdb`. It is NOT a generation file:
`--force` creates a new generation and purges the old graph DB, and the verdicts
must survive that. The stem does not match `^<base>(_v\d+)?$`, so the orphan
sweep never lists it. Only the residual pass opens it, and the pass runs under
the collection's `IndexingLock`, so it opens the file directly rather than
through the codegraph daemon. The pass's graph-DB access — reading
`residual_call_sites`, writing model edges, marking derived tables stale — goes
through `GraphDbClient` ops like every other graph read and write.

| Column                       | Meaning                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `site_key`, `menu_hash`      | the question's identity                                 |
| `model`, `model_version`     | provider id and the model revision it reported          |
| `pick`, `p`                  | chosen candidate and its probability                    |
| `probabilities`              | full distribution over the menu                         |
| `question_payload`           | exactly what was sent to the provider                   |
| `created_at`, `last_seen_at` | `last_seen_at` moves whenever a run sees the site again |

Lifecycle:

- Retention: rows with `last_seen_at` older than
  `CODEGRAPH_RESIDUAL_VERDICT_RETENTION_DAYS` (default 180) are deleted at the
  start of each pass.
- Deleting the project or index (`delete_collection`, `unregister_project`,
  footprint purge) deletes the file. It is registered as a `"logical"`
  `CollectionArtifact` in `CollectionFootprintFactory` (one class plus one line,
  like `CodegraphArtifact`); its clone is a no-op, so a generation swap never
  copies or removes it.
- `--force` / `--force-enrichments` never touch it.

### Model edges — in `cg_symbols_edges_method`

A migration adds nullable `origin`, `model`, `p` and `site_key`; static rows
leave them NULL. Model edges are ordinary method edges, so `get_callers`,
`trace_path`, fanIn and PageRank include them with no separate read path.
`get_callers` / `get_callees` rows carry `origin: "model"`, `model` and `p` on
model edges only — an absent `origin` means static, the way `visibility` is
already reported. `trace_path` traverses model edges but does not label its
steps with `origin` in wave 1.

An edge is applied when the verdict's `site_key` and `menu_hash` match a current
residual row and `p ≥ threshold`. `applyModelEdges` derives the key columns the
table requires: `call_expression = "<receiver_text>.<member>"` from the residual
row, `target_rel_path` from `cg_symbols` for the picked symbol; a pick with no
current residual row or no known target is skipped. It replaces one model's
edges with a scoped row diff (`applyScopedRowDiff`), never a delete-then-insert
of the same key in one transaction.

A re-walked file loses its model edges along with its static ones (its sites get
re-asked or re-applied); an untouched file keeps them; a model edge the static
resolver later proves is rewritten as static, so a later `applyModelEdges`
cannot delete it.

Consequence: after `--force`, unchanged code yields the same `site_key` and
`menu_hash` in the new generation, and its model edges are re-applied from the
store with no provider call. Only new or changed sites reach the model.

## Flow

`index-codebase --resolve-residual=kev`: chunking → embeddings → codegraph
(static resolve, `residual_call_sites` written) → residual pass → derived
recompute. `IndexPipeline` returns before codegraph enrichment settles, so the
pass hooks into `IndexingOps#releaseCollectionWhenEnrichmentSettles` — the one
point where embeddings, enrichment and completion hooks are done and the
`IndexingLock` is still held — through an `afterSettle` callback run by a new
`ResidualResolutionOps`. `resolve-codegraph-residual` claims the same lock
(`IndexingOps#resolveResidual`) and runs the pass against the current
generation.

`ResidualResolutionPass` (`src/core/domains/trajectory/codegraph/residual/`):

1. **Select** residual rows with no verdict for the same `site_key`, `menu_hash`
   and `model_version`. Touch `last_seen_at` on the ones that have one.
2. **Group** questions by enclosing method (one method source, many questions —
   Kev caches it as a prefix) and drop duplicate questions.
3. **Send** groups through a pool of N concurrent requests
   (`CODEGRAPH_RESIDUAL_CONCURRENCY`, default 96). Each group's verdicts are
   written as soon as they arrive, so an interrupted pass resumes where it
   stopped.
4. **Apply** the model's full edge set — every current eligible site whose
   verdict (cached or new) picks a menu entry at or above the threshold — mark
   the generation `cg_derived_stale`, and let finalize recompute derived
   metrics. Then touch the current sites' verdicts and expire by retention.

The pass has two modes. `ask` queries the provider for uncached sites (lookup at
the served model version). `cacheOnly` makes no provider call and re-applies the
newest stored verdict per (`site_key`, `menu_hash`) whatever its model version.
A static re-walk of a file deletes that file's model edges, so `cacheOnly` is
what restores them after an index run that asked nothing.

Failure handling: provider unreachable, or more than `maxGroupFailures`
(default 3) groups failing → the pass ends `skipped` with the reason, still
re-applies the edges its stored verdicts support (as `cacheOnly` does), and
keeps every verdict, so the next run resumes from them. A state over Kev's token
limit (HTTP 422) counts the group's sites as `tooLong` and leaves them without
an edge; it is not a group failure. The index stays complete and correct without
model edges, and indexing does not fail. The CLI command exits 1 on `skipped`.

## Provider port

`ResidualModelProvider`, created by `ResidualModelProviderFactory` from
`--model` (the `EmbeddingProvider` / `EmbeddingProviderFactory` pattern). The
port and its question/answer/verdict types live in
`src/core/contracts/types/codegraph-residual.ts`, because the adapters that
implement or store them may import only `core/{contracts,infra}`:

- `id`, `version()` — provider id and model revision;
- `threshold` — default acceptance threshold, overridable per provider in
  config;
- `health()` — reachable and serving;
- `resolveGroup(group)` → per question `{ pick, p, probabilities }`.

The core sends a neutral question: method source, file, receiver, member, kind,
candidate menu. The provider owns the wire format. `KevResidualProvider`
(`src/core/adapters/kev/`) maps a group to one `/v1/systemone` request (`state`
= method source, one `choice` question per call site) and reads `health()` from
`/v1/models`. URL(s) come from config, like embedding URLs.

## Kev setup (outside this repo)

Kev is installed separately on the GPU host; tea-rags is only an HTTP client.
The setup that makes it fast on a 12 GB WDDM card is documented on a new
`website/docs` page (setup guide):

- ROCm on Windows (TheRock nightly torch + `rocm-sdk-devel`), FLA build
  (`triton-windows` 3.6, `fla_win_shim` for the missing `torch.distributed`,
  clang-cl toolchain env);
- serving wrapper: load + merge + bf16 cast in host memory, then move to GPU;
  CUDA-graph buffers cut to fit (`GRAPH_TOKENS` 8192, `GRAPH_ROWS` 8,
  `ROW_PASS_TOKENS` 8192, `GRAPH_STATES` 4, `BANK_WIDTH` 1024); re-home of any
  weight left in system memory;
- before loading its weights, Kev unloads other models from the same GPU
  (llama-server embedders, Ollama), and it releases its own weights after an
  idle period so the next indexing's embedders find VRAM free;
- diagnostics: a weight reading at ~4 GB/s sits in WDDM system memory (measured:
  1.0 → 13 q/s once every weight was in VRAM);
- tea-rags config: provider URL, threshold, concurrency.

## Testing

- `ResidualResolutionPass` with a fake provider: selection, grouping, dedupe,
  resume after interruption, threshold, edge application.
- Verdict store: retention, survival across `--force`, deletion with the
  project, edge re-application in a new generation with zero provider calls.
- `residual_call_sites` reconciliation: a changed file replaces its slice, an
  unchanged one keeps it.
- `KevResidualProvider` contract test on recorded responses.
- Eval gate `scripts/residual-eval`: the 91-question YARD set, baseline Kev
  0.934 / 0.806 naming-miss (bar 0.93 / 0.80). Wave 2 providers are compared
  with the same script.

## Wave 2

- Providers: Jev, `claude-haiku`, `claude-haiku-cli`.
- Cascade: a verdict below threshold goes to the next provider in
  `--model=kev,claude-haiku`.
- Metaprogramming residual (sink-edges taxonomy), with its own question shape
  and eval.
