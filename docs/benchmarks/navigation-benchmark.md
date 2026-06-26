# tea-rags Navigation Benchmark

Reproducible benchmark comparing a **tea-rags-equipped agent** against a **bare
grep agent** on the **real, bounded-scope navigation tasks an agent actually
performs** during work — "find the definition", "find all usages", "find all
relations of this class", "trace this flow". Each task is anchored to a specific
named class/symbol so its ground truth is **finite and hand-verifiable**.

Measures three outcomes per task: **speed** (wall-clock), **cost** (tokens), and
**quality** (per-case correctness metric).

## Goals

1. **Headline axis — tea-rags vs grep.** Quantify the navigation advantage of a
   DSL-aware semantic index + code graph over lexical search on real, large
   codebases.
2. **Type axis — ruby vs ruby+yard.** Isolate how much YARD type annotations
   lift call-graph resolution quality, by comparing an un-annotated Rails app
   against a richly YARD-typed library.

The two axes are measured **between corpora** (not by ablation): the bare Rails
app is the "ruby" condition, the YARD-typed library is the "ruby+yard"
condition.

## Design principle — bounded real tasks, not abstract graph theory

Every case is a task a developer/agent genuinely issues, scoped to a **single
anchor** (one method, one class, one entry-point) so the answer set is finite
and verifiable. Global graph-theoretic queries (cycle enumeration, global
dead-code by `fanIn=0`, transitive closure to depth N) are **excluded** — they
are architectural-health analytics, not the bounded navigation an agent
performs. Where a global property has a real bounded counterpart, we keep the
bounded form (e.g. "is _this_ method used anywhere?" instead of "list all dead
code").

## Why semantic search works on Rails — DSL-aware chunking

tea-rags chunks Rails source **along DSL boundaries** (Ruby DSL chunker hooks):
`has_many`, `belongs_to`, `validates`, `scope`, `before_action`, callbacks and
similar macros become **discrete, semantically-labelled chunks**. This is the
mechanism behind several cases:

- A DSL declaration (`has_many :statuses`) is a **first-class retrievable
  unit**, not buried noise inside a class body.
- Behaviour search works on Rails because behaviour often **lives in the DSL**
  (validations, callbacks, associations) — and those are chunked as units, so
  the embedding captures the DSL intent.
- "All relations of a class" is answerable because the association macros are
  captured chunks **and** linked by the code graph.

Honest framing of the grep gap: grep **can** find a literal `has_many :statuses`
if the agent already knows the macro to look for. What grep cannot do is (a)
connect a _usage_ `account.statuses` back to that declaration, (b) rank DSL
chunks by behaviour, or (c) enumerate a bounded relation set without N separate
greps and manual union/dedup. The differentiator is **DSL chunking + semantics +
graph**, not "lexical search fails categorically".

## Corpora

| Corpus | Project      | Role                             | Size          | YARD          |
| ------ | ------------ | -------------------------------- | ------------- | ------------- |
| **A**  | Mastodon     | bare Rails app ("ruby")          | ~150k loc     | none          |
| **B**  | graphql-ruby | YARD-typed library ("ruby+yard") | ~31k code loc | density 0.437 |

### Corpus A — Mastodon

- Repo: `https://github.com/mastodon/mastodon`
- Pinned ref: **tag `v4.6.2`, SHA `70d39d364ba6183a2b6e2f763204fe2c21e0ca42`**.
  All ground truth is verified against this exact SHA.
- Character: idiomatic Rails — ActiveRecord, concerns, service objects
  (`app/services/*Service#call`), STI, dynamic dispatch, and heavy DSL
  (associations / validations / callbacks / scopes). Zero YARD type tags → the
  un-annotated "ruby" condition; receiver types are inferred without an
  annotation anchor → honest recall ceiling on dynamic dispatch.

### Corpus B — graphql-ruby

- Repo: `https://github.com/rmosolgo/graphql-ruby`
- Pinned ref: **`28ea3ecbd86e2c8124bd4881b1a943098ad40281`**
- Measured at pin (lib/ tree, tests excluded): ~30.8k code loc, 375 files, 1421
  classes/modules, 2604 methods, `@param` typed 588/597, `@return` typed
  551/578, **type-density 0.437**.
- Why this project: the only shortlist candidate with **both** uniform YARD
  typing **and** real internal method-to-method dispatch on typed receivers.
  Rejected: Sequel (rich call graph but ~0 YARD type tags — the un-annotated
  ceiling); aws-sdk-ec2/core (generated-flat, type-density is a doc artifact, no
  internal call edges).
- Size caveat: no richly-YARD-typed pure-Ruby project reaches 100k+ loc with
  real call edges — the 100k+ candidates are all generated-flat. ~31k is the
  largest honest "ruby+yard" signal. The 150k/31k asymmetry is acceptable: the
  corpora measure different things.

### Index scope — `.contextignore`

Each corpus is indexed **code-only**. A per-corpus `.contextignore`
(`docs/benchmarks/contextignore/<corpus>.contextignore`, gitignore syntax,
copied to the corpus root at setup) drops domain junk on top of tea-rags'
builtin defaults (which already cover `node_modules/`, `vendor/bundle/`,
`log`/`tmp`/ `coverage/`, `*.min.js`) and the repo's own `.gitignore`.

- **Mastodon** — drops non-Ruby frontend (`app/javascript/`, `app/assets/`,
  JS/CSS), view templates (`app/views/`, ERB/HAML), i18n + config data
  (`config/locales/`, `*.yml`), DB schema/migrations (`db/`), and markdown.
- **graphql-ruby** — drops `guides/`, `website/`, `benchmark/`, JS, and
  markdown, leaving `lib/` as the indexed surface.

**Tests/specs are excluded** (`/spec/`) so the benchmark measures
**production-source** navigation and ground-truth usage/reference sets are
defined over production source only. Both conditions see the same code set (the
bare agent greps the same checkout; the `.contextignore` scope is also applied
to its task boundary). This is a deliberate design choice: to bring tests
in-scope, remove the `/spec/` line from both `.contextignore` files —
ground-truth usage/reference sets must then include test call sites.

## Agent conditions

Both conditions run the **same model** (pin one model id per run and report it),
the **same task prompt**, the **same max-turn budget**, and a **fresh context
per task** (no cross-task memory).

- **`bench-tea-rags`** — discovery via tea-rags only. Tool allowlist: `Read` +
  `mcp__tea-rags__*` (symbol resolution, reverse/forward call graph,
  class-neighborhood / reference queries, path tracing, semantic/hybrid search,
  similarity, candidate-set rerank). Built-in `Grep`/`Glob`/`Bash` are **not**
  in the allowlist; `Read` is for quoting a final location only.
- **`bench-bare`** — **default Claude tools only**. Tool allowlist: `Grep`,
  `Glob`, `Read`, `Bash`. **No MCP server** is available — `mcp__tea-rags__*` is
  forbidden. Same model and prompt otherwise.

Enforcement is the **agent-definition tool allowlist**, not the prompt; the
prompt is a secondary guard. The two agent definitions are specified in the
Runbook.

The index is built **once per corpus** before the run (`index_codebase` against
a dedicated project alias per corpus, at the pinned SHA, enrichment complete).
The `bench-bare` agent works against the raw checkout at the same SHA.

## Metrics

| Metric         | Definition                                                      |
| -------------- | --------------------------------------------------------------- |
| **Wall-clock** | seconds from task start to final answer                         |
| **Tokens**     | total input+output tokens consumed (proxy for irrelevant reads) |
| **Quality**    | per-case correctness metric (see each case)                     |

Each task is run **N = 5** times per condition; report **median + spread**
(P25/P75). Headline aggregates per axis: speed ratio, token ratio, quality
delta.

## Ground-truth protocol

For every task, ground truth is **hand-verified at the pinned SHA** and stored
as a JSON fixture (expected definition location, usage set, relation set, path,
behaviour-target chunks, sibling set, candidate ordering). Each anchor is a
**specific named class/method** so the set is finite. Construction rules are
per-case (e.g. D1 requires zero lexical overlap between query and target
identifiers).

## Cases

Six groups by **unit of bounded scope**. Format per case: task / why / tea-rags
/ grep / anchors / quality.

### Group A — symbol-scoped (anchor = one method/constant)

#### A1 — Find the definition

- **Task.** Resolve a symbol to its definition — exact `file:line-range` + body,
  correctly disambiguated. Four difficulty tiers:
  - **(a) distinct name** — e.g. `PostStatusService#call`.
  - **(b) high-frequency name** — name that is also a common word and saturates
    the corpus (`Status` class, `process`, `result`); tests hybrid retrieval
    precision under token noise.
  - **(c) DSL-defined** — a method that exists only via a macro
    (`account.statuses` → the `has_many :statuses` declaration line); resolved
    via DSL-chunked declaration, no static `def`.
  - **(d) inherited / super** — the definition that actually runs for `X#m` when
    the receiver class doesn't define `m` (resolved via ancestor chain incl.
    prepend), and the `super` target one step up.
- **Why.** The atomic primitive — every other task first resolves a symbol. The
  four tiers cover where real Ruby makes resolution hard: same-name collisions,
  high-frequency noise, DSL generation, and inheritance/`super`.
- **tea-rags.** Tier (a)/(b): qualified-id / hybrid lookup → single definition,
  exact-name boosted above noise. Tier (c): DSL-chunked declaration is the
  definition surface. Tier (d): walks ancestors (incl. singleton-class mixins,
  prepend order) and resolves `super` to the next-up definition; honest
  "external" when the target is core/gem.
- **grep.** (a) dozens of `def call`, manual namespace reconstruction. (b)
  thousands of `Status` matches, lexically unrankable. (c) `grep "def statuses"`
  → zero; must know the macro to find `has_many`. (d) lists every `def m`,
  cannot compute MRO; `super` has no name to grep.
- **Anchors.** Per tier, per corpus (Mastodon `PostStatusService#call`,
  `Status`, `account.statuses`, a concern-inherited method; graphql-ruby
  `GraphQL::Schema::Field#resolve`, `result`, a generated accessor, a
  `Schema::Member`-inherited method).
- **Quality.** Binary correct location per tier; reported per tier (the gap
  widens from (a)→(d)).

#### A2 — Find all usages of a method

- **Task.** Enumerate the **true** call sites of `<Class>#<method>` (receiver
  actually of that type), excluding same-named methods on other types. Includes
  a bounded **dead-code sub-judgment**: is this method used anywhere in-project
  (yes/no)?
- **Why.** Core impact question ("what calls this / is it safe to
  change/remove"). Ruby hardness is receiver-type resolution: `x.m` is a true
  usage of `C#m` only if `x` is a `C`. First case where YARD types materially
  change resolution → measures both axes.
- **tea-rags.** Reverse edges resolved by receiver type (static inference + YARD
  type-source) → only sites dispatching to this exact method. graphql-ruby →
  near-complete via YARD; Mastodon → honest recall, no fabricated edges; the
  dead-code answer flags dynamic-dispatch-only entry rather than claiming
  "dead".
- **grep.** `grep "\.<method>"` → every textual match regardless of receiver
  type; manual back-tracing to discard false positives; delegated/metaprogrammed
  callers unrecoverable. The naive `fanIn=0` dead-code answer is dangerous
  (misses dynamic callers → calls live code dead).
- **Anchors.** Mastodon `Account#suspended?`; graphql-ruby
  `GraphQL::Query#result`.
- **Quality.** Precision + recall of the usage set (report ruby-vs-yard recall
  delta); for the dead-code sub-judgment, precision is paramount (live code
  flagged dead is the dangerous error).

#### A3 — Find all usages of a class/constant

- **Task.** Find all references to a class/module/constant (instantiation,
  subclassing, namespacing, type reference), excluding string/comment mentions.
- **Why.** "Where is this type used" — distinct from method usages (A2). A
  constant's blast radius.
- **tea-rags.** Code-graph symbol references for constants → real reference
  sites.
- **grep.** Token `Account` matches everywhere — comments, strings, substrings,
  unrelated namespaces → low precision, heavy manual filtering.
- **Anchors.** Mastodon `Account` / `Status`; graphql-ruby `GraphQL::Query`.
- **Quality.** Precision + recall; precision is where grep collapses
  (string/comment noise).

#### A4 — Find what a method uses (callees)

- **Task.** For `C#m`, the set of methods it invokes, each resolved to its
  definition (`file:line`), correct among same-named.
- **Why.** Comprehension primitive ("what does this method actually do").
  Forward resolution depends on **return-type propagation** through chains
  `a.b.c`, whereas A2 depends on receiver/param types — the two stress different
  parts of the type-source mechanism.
- **tea-rags.** Forward edges resolved by receiver type: self → known; typed
  param/return → YARD; chain → propagates return types hop by hop. graphql-ruby
  holds the chain; Mastodon breaks at the first untyped hop → honest partial.
- **grep.** Greps each called name → multiple `def` per name, no receiver type
  to pick; chained `a.b.c` unresolvable.
- **Anchors.** Mastodon `PostStatusService#call`; graphql-ruby
  `GraphQL::Schema::Field#resolve`.
- **Quality.** Precision + recall of callees, broken down by edge class
  (self-send / typed-param / chained-return) to localize the YARD delta.

### Group B — class-scoped (anchor = one class)

#### B1 — Find all relations of a class

- **Task.** For class `C`, enumerate its complete **bounded relation
  neighborhood**: (1) DSL associations (`has_many`/`belongs_to`/`has_one`), (2)
  included/extended modules (concerns), (3) direct subclasses + superclass, (4)
  inbound references (who uses `C` as a type), (5) outbound calls to other
  in-project classes, (6) file-level dependencies. One class → finite set.
- **Why.** The canonical onboarding / refactoring question — "give me the full
  picture of this class, what is it wired to". The headline real bounded task.
  Its power on Rails comes directly from DSL-aware chunking: associations are
  captured chunks, linked by the graph.
- **tea-rags.** Single class-neighborhood query over the code graph +
  DSL-chunked associations → the full relation set in one pass, with `file:line`
  per relation.
- **grep.** Must run ~6 different greps (`has_many`, `include`, `< C`, `C.new`,
  `C.`, `require`) and manually union/dedup; misses autoload/implicit deps,
  duck-typed users, and DSL-generated relations.
- **Anchors.** Mastodon `Account` (rich: many associations, many included
  concerns, widely referenced); graphql-ruby `GraphQL::Query` /
  `GraphQL::Schema::Field`.
- **Quality.** Precision + recall of the relation set, **broken down by relation
  kind** (association / mixin / subclass / reference / call / file-dep). The
  kind-breakdown shows where DSL-chunking + graph beats grep.

#### B2 — Find all subclasses / implementers

- **Task.** Enumerate all (transitive) subclasses of `C` **and** duck-typed
  implementers of a contract `#m`.
- **Why.** "All services", "all serializers", "everything responding to `#call`"
  — inheritance-tree + contract navigation.
- **tea-rags.** Inheritance edges (transitive subclasses) + the symbol set
  defining `#m` (duck-typed implementers).
- **grep.** `< C` finds direct explicit subclasses only (misses transitive,
  `Class.new(C)`); duck-typed implementers fall back to `grep "def m"` →
  A1-style noise.
- **Anchors.** Mastodon subclasses of `ApplicationService` /
  `ApplicationRecord`; graphql-ruby subclasses of `GraphQL::Schema::Object`.
- **Quality.** Precision + recall of the implementer set.

### Group C — flow-scoped (anchor = one entry-point)

#### C1 — Trace a flow

- **Task.** Find a concrete call path from one entry-point A to a deep effect B,
  with `file:line` per hop. Scoped to a single entry.
- **Why.** Cross-layer control-flow comprehension ("how does this request end up
  calling the notifier"). Hardness is **compounding**: a path of length k needs
  k consecutive resolved edges; at per-edge recall p, path recall ≈ pᵏ — the
  most dramatic YARD case. Dominant quality risk: fabricated edges.
- **tea-rags.** Reachability over resolved edges → concrete path per-hop.
  graphql-ruby (typed) finds long paths; Mastodon reports honest "no resolved
  path" rather than inventing one at an untyped hop.
- **grep.** No graph — manual BFS; per-edge ambiguity explodes branching;
  chained hops unresolvable; intractable past 2–3 hops; high risk of
  hallucinating a path.
- **Anchors.** Mastodon `Api::V1::StatusesController#create` → notification /
  ActivityPub dispatch (4–6 hops); graphql-ruby `GraphQL::Schema#execute` →
  `GraphQL::Schema::Field#resolve` (4–6 hops).
- **Quality.** (a) path found y/n, (b) path correctness (fabricated edge
  penalized hard), (c) length reached before break. Headline plot: path-recall
  vs hop-count.

### Group D — behavior/semantic (anchor = an intent)

#### D1 — Find where a behavior lives

- **Task.** Find code implementing a described behaviour, where query terms do
  **not** appear verbatim in the code (intent paraphrase, not a symbol name).
- **Why.** The dominant real need on an unfamiliar codebase ("I know WHAT, not
  WHERE/what it's called"). On Rails much behaviour lives in DSL (validations,
  callbacks) → DSL-chunking surfaces it semantically.
- **tea-rags.** Embedding retrieval by semantic proximity regardless of lexical
  overlap; hybrid keeps exact-name working; DSL chunks let behaviour-in-DSL be
  found.
- **grep.** Must guess keywords; iterates synonym sets, most missing the real
  identifier; no convergence guarantee + a real failure-floor.
- **Anchors / queries.** Mastodon "where is client request frequency limited" →
  `Rack::Attack` throttling; graphql-ruby "where is query complexity/depth
  limited against abuse" → `Analysis::AST::MaxQueryDepth` / `max_complexity`.
- **Construction rule.** Queries validated to have **zero lexical overlap** with
  target identifiers.
- **Quality.** Rank of the true chunk (hit@1/@k); for grep, converged-or-not.
  Token cost = number of failed iterations.

#### D2 — Find similar implementations

- **Task.** Given one reference chunk, find its structural/behavioural siblings
  — code shaped the same way under different naming.
- **Why.** Pattern navigation: consistency refactor, find a precedent before
  writing new code, near-duplicate detection. Similarity lives in the **shape**,
  not in shared substrings.
- **tea-rags.** Embeds the reference, returns nearest neighbors in
  code-embedding space — siblings regardless of naming. Input is an example, not
  a pattern spec.
- **grep.** Must reverse-engineer the shape into a literal/regex; a behavioural
  pattern rarely reduces to a stable token → low recall (signature substring) or
  low precision (too broad).
- **Anchors.** Mastodon `PostStatusService` (validate→process→postprocess /
  `#call`) → sibling service objects; graphql-ruby one field-resolver / type
  class.
- **Quality.** Precision + recall of the sibling set.

### Group E — triage / end-to-end (real session shape)

#### E1 — Rerank a candidate set for read-order

- **Task.** Given a fixed candidate set of files/chunks, order them by relevance
  to a task description ("which of these N to read first").
- **Why.** A real agent action: candidates already in hand (prior step / PR diff
  / directory), need relevance ordering, not discovery. Mirrors triage.
- **tea-rags.** Reranks the provided set by semantic relevance → correct
  read-order.
- **grep.** No relevance model; at best keyword-hit counts per file → poor
  order, or reads all (token blowup).
- **Inputs.** A curated candidate set + a task query per corpus; ideal order
  hand-verified.
- **Quality.** Rank correlation (NDCG / top-1 correct) vs ground-truth ordering.

#### E2 — Composite multi-hop task (end-to-end)

- **Task.** A realistic multi-step task chaining navigation — e.g. "a status
  fails to federate; locate the responsible method, its callers, and the config
  that gates it" → search → graph → search.
- **Why.** Real sessions chain primitives; this measures **end-to-end**
  turns/tokens/quality where tea-rags collapses N agent turns into few. Single-
  primitive cases understate the compounding advantage; this captures it. The
  headline real-world case.
- **tea-rags.** Each hop is one indexed operation; few turns, bounded context.
- **grep.** Each hop re-greps + re-reads; context accumulates (rot), turns
  multiply, tokens explode.
- **Anchors.** 2–3 scripted multi-hop scenarios per corpus with a verifiable
  end-artifact.
- **Quality.** Correct final artifact (binary) + turns-to-completion + total
  tokens.

### Group F — control

#### F1 — Literal-marker search (grep parity)

- **Task.** Find all literal markers — `TODO`/`FIXME`/`HACK`, a specific error
  string, an exact config key.
- **Why.** Control. Not every task favours tea-rags; literal-string search is
  grep's home turf. A parity case keeps the benchmark honest and calibrates the
  delta (where the index gives no advantage / slight overhead).
- **tea-rags.** Exact/literal search works but the index gives no edge here.
- **grep.** Ideal tool — direct, fast, complete.
- **Anchors.** Marker set per corpus.
- **Quality.** Precision + recall (should ≈ tie); the point is parity, surfacing
  honest no-advantage zones.

## Coverage map

| Case | Bounded task                        | tea-rags capability                            | Axis                       |
| ---- | ----------------------------------- | ---------------------------------------------- | -------------------------- |
| A1   | find definition (4 tiers)           | symbol resolution + DSL chunk + ancestor/super | tea-vs-grep (+yard tier d) |
| A2   | find usages of a method (+is-used?) | reverse edges by receiver type                 | + ruby-vs-yard             |
| A3   | find usages of a class/constant     | constant references                            | tea-vs-grep                |
| A4   | what a method uses                  | forward edges, return propagation              | + ruby-vs-yard             |
| B1   | all relations of a class            | class neighborhood + DSL associations          | tea-vs-grep (DSL chunking) |
| B2   | subclasses / implementers           | inheritance edges + contract set               | tea-vs-grep                |
| C1   | trace a flow                        | reachability over edges                        | + ruby-vs-yard (pᵏ)        |
| D1   | where a behavior lives              | DSL-aware semantic retrieval                   | tea-vs-grep                |
| D2   | find similar implementations        | structural similarity                          | tea-vs-grep                |
| E1   | rerank candidates                   | candidate-set rerank                           | tea-vs-grep                |
| E2   | composite multi-hop                 | chained navigation, bounded context            | tea-vs-grep (end-to-end)   |
| F1   | literal markers                     | exact search (control)                         | parity                     |

## Out of scope

- **Global graph analytics** — cycle enumeration, global dead-code, transitive
  closure to depth N. These are architectural-health queries, not bounded
  navigation an agent issues; their bounded counterparts are folded in (e.g.
  A2's "is this method used?").
- **git-signal rerank / analytics presets** (`ownership`, `techDebt`,
  `hotspots`, `securityAudit`, …) — a risk/health axis, a separate benchmark.

## Prerequisites (one-time per run)

1. **Pin the model.** One model id, recorded in the run manifest; both subagents
   use it.
2. **Clone corpora at pinned SHAs:** `bench/corpora/mastodon` @ `70d39d36`
   (v4.6.2), `bench/corpora/graphql-ruby` @ `28ea3ec`. Then copy the matching
   `docs/benchmarks/contextignore/<corpus>.contextignore` to each corpus root as
   `.contextignore` (see "Index scope" below) so the index covers code only.
3. **Index each corpus with tea-rags** as a dedicated alias at the pinned SHA,
   enrichment complete:
   - `tea-rags index-codebase --project bench-mastodon --path bench/corpora/mastodon --wait-enrichments --force --json`
   - same for `bench-graphql-ruby`. Verify `get_index_status` shows
     `codegraph.symbols` healthy for each.
4. **Reconnect MCP** so the server reflects the build under test (build + link
   first if testing local tea-rags changes).
5. **Ground-truth fixtures** present at `bench/fixtures/<case>.<corpus>.json`,
   hand-verified at the pinned SHA — one finite set per anchor.
6. **Agent definitions installed:** `.claude/agents/bench-tea-rags.md`,
   `.claude/agents/bench-bare.md`, with the tool allowlists below.

## Runbook — running one case

One case run = **two subagents on the same task, same model, fresh context,
spawned in parallel** — one with tea-rags, one bare.

### Agent definitions

`bench-tea-rags` (frontmatter + system prompt):

```text
---
name: bench-tea-rags
tools: Read, mcp__tea-rags__find_symbol, mcp__tea-rags__get_callers,
  mcp__tea-rags__get_callees, mcp__tea-rags__trace_path,
  mcp__tea-rags__hybrid_search, mcp__tea-rags__semantic_search,
  mcp__tea-rags__find_similar, mcp__tea-rags__rank_chunks
---
All code discovery goes through tea-rags. Use Read only to quote a final
location. Index alias: bench-<corpus>. Return the structured answer schema.
```

`bench-bare` (frontmatter + system prompt):

```text
---
name: bench-bare
tools: Grep, Glob, Read, Bash
---
Use only built-in search/read tools. No MCP. tea-rags is forbidden. Return the
structured answer schema.
```

### Per-case procedure

For each (case, corpus):

1. Load the case task prompt + ground-truth fixture.
2. Spawn `bench-tea-rags` and `bench-bare` **in parallel** — identical task
   prompt, working dir = corpus checkout, fresh context.
3. Each returns a **structured final answer** matching the case answer schema.
4. Capture per subagent: **wall-clock** (spawn→final), **tokens** (in+out), the
   **answer**.
5. **Score** the answer vs the fixture → the case quality metric.
6. Repeat 2–5 **N = 5** (fresh subagents); record median + P25/P75.
7. Emit a result row per condition.

### Result row schema

```json
{
  "case": "A2",
  "corpus": "mastodon",
  "condition": "tea-rags|bare",
  "model": "<id>",
  "runs": 5,
  "wall_clock_s": { "p25": 0, "p50": 0, "p75": 0 },
  "tokens": { "p25": 0, "p50": 0, "p75": 0 },
  "quality": { "metric": "precision_recall", "precision": 0, "recall": 0 },
  "answer_ref": "bench/runs/<ts>/A2.mastodon.<condition>.jsonl"
}
```

Headline report: per axis (tea-vs-grep, ruby-vs-yard) aggregate speed ratio,
token ratio, quality delta across cases; plus the C1 path-recall-vs-hop-count
plot, the A2/A4 ruby-vs-yard recall deltas, and the B1 relation-kind breakdown.
