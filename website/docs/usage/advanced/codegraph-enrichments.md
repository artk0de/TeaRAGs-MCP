---
title: Codegraph Enrichments
sidebar_position: 5.1
---

import AiQuery from '@site/src/components/AiQuery';
import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';

# Codegraph Enrichments

:::caution Beta feature

Codegraph enrichment is a **beta** capability — **disabled by default**. The
graph extraction and structural signals are still being calibrated across
languages. Resolution recall varies by language, and signal semantics may change
between releases. Opt in with `CODEGRAPH_ENABLED=true`.

:::

While [git enrichments](/usage/advanced/git-enrichments) answer _"how has this
code behaved over time?"_, codegraph enrichment answers _"how is this code
connected **right now**?"_. tea-rags extracts your project's **call graph** and
**import graph** into a per-project [DuckDB](https://duckdb.org/) database, then
attaches **structural graph signals** — fan-in, fan-out, instability, PageRank,
transitive impact — to every indexed chunk. Your agent can rank by architectural
importance and blast radius, not just relevance and history.

## What It Is

Codegraph is a **trajectory enrichment family** (internal key
`codegraph.symbols`). At index time, per-language tree-sitter walkers extract
symbols, imports, and call sites; per-language resolvers turn those into graph
edges stored in DuckDB (one `.duckdb` file per indexed project under
`<dataDir>/codegraph/`). Two graphs are built:

- **Import graph** (file-to-file) — which files import which, used for
  file-level coupling signals.
- **Call graph** (symbol-to-symbol) — which functions/methods call which, used
  for symbol-level signals and cycle detection.

<MermaidTeaRAGs>
{`
flowchart LR
    Codebase[📁 Source Files<br/><small>+ call sites + imports</small>]

    subgraph extract["Codegraph Extraction"]
        Walk[🌲 tree-sitter walkers<br/><small>per language</small>]
        Resolve[🔗 symbol resolvers<br/><small>call → edge</small>]
        Graph[(🗄️ DuckDB<br/><small>per-project graph DB</small>)]
        Walk --> Resolve --> Graph
    end

    Signals[📊 Graph Signals<br/><small>fanIn · fanOut · pageRank<br/>instability · transitiveImpact</small>]
    Qdrant[(🗄️ Qdrant<br/><small>enriched chunks</small>)]

    Codebase --> Walk
    Graph --> Signals --> Qdrant
`}
</MermaidTeaRAGs>

For the theory behind these metrics (Henry & Kafura fan-in/fan-out, Martin
instability, PageRank centrality and bug-proneness), see
[Code Quality Metrics](/knowledge-base/code-quality-metrics).

## Enabling Codegraph

Codegraph is **disabled by default** (beta). Opt in with `CODEGRAPH_ENABLED`:

```bash
claude mcp add tea-rags -s user -- node /path/to/tea-rags/build/index.js \
  -e CODEGRAPH_ENABLED=true
```

While disabled (the default), the entire family is dropped — no graph
extraction, no graph signals on payloads, and the codegraph MCP tools
(`get_callers`, `get_callees`, `find_cycles`) are not registered. Re-index after
enabling so payloads carry the new signals.

## Supported Languages

Graph extraction runs for **8 languages** across 15 extensions:

| Language   | Extensions                    |
| ---------- | ----------------------------- |
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` |
| Python     | `.py`                         |
| Ruby       | `.rb`                         |
| Go         | `.go`                         |
| Java       | `.java`                       |
| Rust       | `.rs`                         |
| Bash       | `.sh`, `.bash`                |

Files in other languages are still indexed and embedded by tea-rags — they just
carry no codegraph signals.

## What You Get

Codegraph computes signals at **two scopes**:

### File-scope signals (import graph)

| Signal                          | What it tells you                                                       |
| ------------------------------- | ----------------------------------------------------------------------- |
| `codegraph.file.fanIn`          | Number of files importing this file (afferent coupling)                 |
| `codegraph.file.fanOut`         | Number of files this file imports (efferent coupling)                   |
| `codegraph.file.instability`    | Martin instability `fanOut / (fanIn + fanOut)`, range 0–1               |
| `codegraph.file.connectionCount`| Total file-graph edges `fanIn + fanOut` (support for instability confidence) |
| `codegraph.file.isHub`          | `true` when fanIn exceeds the collection p95 (heavily depended-upon)     |
| `codegraph.file.isLeaf`         | `true` when fanOut is 0 and fanIn > 0 (pure dependency, depends on nothing) |
| `codegraph.file.transitiveImpact`| Distinct files that transitively import this file (reverse BFS, depth-capped at 5) — the real blast radius |

### Symbol-scope signals (call graph)

| Signal                    | What it tells you                                              |
| ------------------------- | ------------------------------------------------------------- |
| `codegraph.chunk.fanIn`   | Distinct call sites invoking this symbol (method-level fan-in) |
| `codegraph.chunk.fanOut`  | Outgoing calls from this symbol (method-level fan-out)         |
| `codegraph.chunk.pageRank`| PageRank over the call graph (damping 0.85, normalized 0–1) — recursive importance |

:::info Why two fan-in's?

`codegraph.file.fanIn` and `codegraph.chunk.fanIn` measure **different graphs** —
file imports vs. method call sites — so they are not interchangeable. A file
with low import fan-in can still contain a method everyone calls. Standard
alpha-blending between file and chunk does **not** apply to codegraph signals for
this reason.

:::

## MCP Tools

When codegraph is enabled, these graph-query tools become available (they read
the pre-computed DuckDB graph directly — no embedding):

| Tool          | Returns                                                                              |
| ------------- | ----------------------------------------------------------------------------------- |
| `get_callers` | Symbols that **invoke** the given `symbolId` (who depends on this)                   |
| `get_callees` | Symbols **invoked by** the given `symbolId` (what this depends on)                   |
| `find_cycles` | Strongly-connected components (cycles ≥ 2) in the import graph (`scope: "file"`) or call graph (`scope: "method"`) |
| `get_architecture_report` | Architecture violations with per-line evidence. Stable Dependencies Principle judged on components (modules with a measured facade, else directories) — a stable component depending on a less stable one, grouped into root causes by unstable target, with the file edges that carry it; plus leaking abstractions, silent coupling and main-sequence distance (zone of pain / uselessness, abstractness from the walker type census). Scripts, spikes, benchmarks, examples and fixtures are left out. Optional `pathPattern` scopes the judged edges by source file |
| `get_naming_lexicon` | The project's naming vocabulary: names per declaration kind for given `types` / `anchors`, a `CONFORMS` / `MISFIT` / `NEW_TERM` / `COLLISION` verdict per draft in `names` (values, and types or constants with `kind: "type"`), project terms for a `concept` (with `language`), and a review of the names a diff adds (`changes`) |
| `get_ontology_report` | Project-wide naming ontology audit over declared identifiers: `synonyms` (one type, many names), `homonyms` (one name, many types), `outliers` (a name off its type's dominant naming shape) and `collisions` (a name equal to another symbol). Ranked, with counts and one example location each |

**Call-graph resolution scope.** `get_callers` / `get_callees` walk the run-time
hierarchy (Class Hierarchy Analysis), which reaches **structural**
implementers too: a TypeScript class or object-literal factory that satisfies
an interface or an object-type alias without `implements`, and a Python class
that satisfies a `typing.Protocol` without subclassing it, descend from that
contract in the cone. A host-class id whose member is actually defined by an
included module or concern — `Account.suspended` when `suspended` lives in
`Account::Suspensions` — resolves through the class's MRO to the definer; the
response names it in `resolvedSymbolId` whenever the id you asked for differs
from where the edges live. Either tool also takes `relativePath` in place of
`symbolId` to answer at **file scope** straight from the import graph — the
files importing it (`get_callers`) or the files it imports (`get_callees`),
heaviest first by call weight. Where the graph records a symbol's declared
visibility, `get_callees` targets, `get_callers` callers, `trace_path` steps
and `find_symbol` outline members all carry it (`private` / `protected` /
`public`), omitted rather than guessed when the graph has no answer.

`trace_path` distinguishes a genuine read failure from "no path exists": an
unreadable or corrupt graph surfaces its typed error (`INFRA_CODEGRAPH_DATABASE_MISSING`
and friends) instead of answering an empty path list, while a project the
codegraph never indexed still answers empty — the same rule every other graph
tool follows on an unbuilt graph. No graph read, successful or not, ever
creates a database file as a side effect.

`get_naming_lexicon` reads the identifier declarations the codegraph records —
params, locals, fields and return types, each with the type it is known to hold.
A type comes from an annotation, a constructor, a resolver binding, a finder
call (`Doc.find(id)`), the return of the one method a call resolves to, or —
counted apart as `name-inferred` — a name that holds one type in at least 80% of
its typed uses. The shapes it reports (`EXACT`, `QUALIFIED`, `TAIL`,
`VERB_TYPE`, `CALLEE_DERIVED`, `FREE`) are induced from those rows, never
assumed: a project that names by role gets a `FREE`-dominant answer and no
forced suggestion. Casing per role comes from the language descriptor. An index
built before the identifier table existed answers with a `driftWarning` naming
the reindex.

**Type and constant names.** A draft with `kind: "type"` carries the file it
will live in (`path`) and, optionally, its planned ancestor (`extends`). The
names come from the type declarations the codegraph records, so an index built
before those existed needs a codegraph recompute
(`--force-enrichments codegraph`) before types and constants are judged. A
type's expected role is its suffix (`…Strategy`, `…Preset`, `…Store`), taken
from the strongest evidence available: the ancestor's family first, then the
directory's dominant suffix, then a suffix used across the project. The
project-wide suffix only confirms a name; it never makes one a `MISFIT`,
because a suffix popular elsewhere is a guess, not an expectation. A name that
lacks its family's or directory's role is `MISFIT` with the role appended; a
short name that already names a type in another module is `COLLISION`. Term
alignment checks each word against the project's established words for the
same concept and offers `alternatives` — on a `NEW_TERM` when the words
literally overlap (for example `Predefined` where the project writes
`PredefinedTemplate` and `PredefinedField`), and also on a `CONFORMS` when the
draft's head is a **synonym** of an established term recognized by the index's
own embedding model (`EmbeddingBackend` → `provider`, `SignalStatistics` →
`stats`) — a synonym confirmed only by a matching project suffix is exactly
what a bare `CONFORMS` would otherwise wave through. The similarity floor is
the project's own null distribution of unrelated head pairs, corrected for how
many candidates the draft was scored against, so it holds the same ~10% false-positive
rate regardless of the draft's directory or family size. That verdict stays
soft: the agent decides whether to reuse the term.

**Reviewing a diff.** `changes: {}` reviews the working tree against `HEAD`,
untracked files included; `changes: { base }` reviews a branch. The base is
read at its merge-base with `HEAD` (`git merge-base <base> HEAD`), so
`base: "origin/main"` reviews what the branch changed, plus uncommitted work,
however far `origin/main` has moved on since the branch left it — the
three-dot view a reviewer means, not a diff against the base's tip. A commit
`HEAD` descends from is its own merge-base, so passing a sha pins the
comparison exactly. When the base shares no history with `HEAD` (unrelated
roots, or a shallow clone that cut the fork point off) the call fails and says
so. The answer reports the commit it used (`mergeBase`) and how many files
differ from it (`changedFiles`). `files: [...]` narrows the review to the listed
files: a file with a diff is reviewed by its added hunks, and a file with none —
committed code on a clean tree — is reviewed whole, every declaration it holds,
and counted in `wholeFiles`. Only declarations inside added
hunks are judged, so an unchanged name in a touched file is not reported. The
changed files are left out of every evidence read, so a change an incremental
reindex has already stored cannot vote for itself. One call covers at most 200
changed files; the rest are reported as `truncated`. Test and other
non-production files are skipped, as are files no codegraph language walks;
both count toward `notJudged`.

The answer sits under `review`. Declarations that conform are only counted
(`conforming`), and so are `novel` ones: a `NEW_TERM` with no `topTerms` and no
`alternatives`, where the project has nothing to compare the name with, so
there is nothing to act on. Everything else is a finding with its file and
line. A finding carries its verdict's fields: `suggestion` and `holder` (or
`role`) on a `MISFIT`, `existing` on a `COLLISION`, `topTerms` and
`alternatives` on a `NEW_TERM`. A name judged generic is listed even when it
conforms, with `genericName`. `checked = conforming + novel + findings`.

`checked` counts only what was judged. A method whose return type is unknown —
most of them in Ruby — still becomes a draft: it is judged against the
project's method vocabulary instead of a type, so it counts in `checked` like
any other name. Only files go unjudged. `notJudgedBy` says what the review
skipped, per reason:
`{ "file": { "nonProduction": 3, "noCodegraphLanguage": 1 } }`.
Reasons are `nonProduction`, `noCodegraphLanguage` and `unreadable`, and they
add up to `notJudged`. `notJudgedNames` lists the first 50 of them with path,
line and name, so a reviewer knows what still needs reading by hand. An
excerpt from a live run on this repository:

```json
{
  "review": {
    "base": "HEAD",
    "checked": 163,
    "conforming": 93,
    "novel": 58,
    "findings": [
      {
        "relPath": "src/core/api/internal/ops/naming-lexicon-ops.ts",
        "line": 373,
        "name": "req",
        "kind": "param",
        "type": "NamingLexiconRequest",
        "verdict": "NEW_TERM",
        "topTerms": [],
        "genericName": { "typeCount": 7, "n": 10 }
      },
      {
        "relPath": "src/core/domains/trajectory/git/provider.ts",
        "line": 846,
        "name": "meta",
        "kind": "local",
        "type": "GitFileSignals",
        "verdict": "MISFIT",
        "suggestion": "fileSignals",
        "holder": "assembleFileSignals"
      }
    ],
    "notJudged": 19
  }
}
```

The excerpt keeps two of the run's 12 findings.

Use `names` for a single proposed name or a rename, and `changes` to review
everything a change introduces.

`get_ontology_report` counts a declaration as evidence only when its type is
known — annotated, constructor, resolver binding, finder or the return type of
the single method it is bound to — and never from a name-inferred type, so the
report cannot confirm its own convention. Names bound to many unrelated types
(`result`, `data`, `item`) are detected from the data, dropped from every
section and listed in the summary; primitive and top types per language are
ignored. An index built before the identifier table existed answers a
`driftWarning` instead of an empty, clean-looking report.

These pair naturally with [`find_symbol`](/usage/advanced/mcp-tools), which
resolves a name to a `symbolId` using the same `Class#method` (instance) /
`Class.method` (static) convention the codegraph tools consume.

## Use Cases

<AiQuery>What would break if I change this function? Show me its callers</AiQuery>
<AiQuery>Find the architectural hubs in this codebase</AiQuery>
<AiQuery>Are there any circular imports between modules?</AiQuery>
<AiQuery>Is this codebase laid out correctly? Which modules depend on less stable ones?</AiQuery>
<AiQuery>Show me entry-point files nothing else imports from</AiQuery>
<AiQuery>What does this service depend on transitively?</AiQuery>

## Reranking Presets

Codegraph signals power **composite presets** that blend the structural graph
with git history. These presets are only available when codegraph is enabled
(they declare a `requires` dependency and are silently dropped otherwise):

| Preset            | Requires                  | Use case                                                      |
| ----------------- | ------------------------- | ------------------------------------------------------------ |
| `blastRadius`     | codegraph + git           | Rank by how much a change ripples out (fan-in + transitive impact + churn) |
| `architecturalHub`| codegraph + git           | Find the load-bearing files everything depends on            |
| `dangerous`       | codegraph + git           | High blast radius **and** high bug-fix rate — change with care |
| `entryPoint`      | codegraph                 | Leaf/entry files — natural starting points for onboarding    |

Enabling codegraph also upgrades the shared presets (`hotspots`, `techDebt`,
`codeReview`, `ownership`, `securityAudit`) to composite versions that factor
structural coupling into their scoring.

## Scoring Weights Reference

Weight keys available for custom reranking (`rerank: { "custom": { ... } }`)
when codegraph is enabled:

| Key                | Signal                                                          | Scope  |
| ------------------ | -------------------------------------------------------------- | ------ |
| `fanIn`            | Normalized files importing this file                           | file   |
| `fanOut`           | Normalized files this file imports                             | file   |
| `fanOutPerLine`    | Efferent coupling per line of code                             | file   |
| `instability`      | Martin instability (already 0–1)                               | file   |
| `isHub`            | 1 when file is a hub (fanIn > p95)                             | file   |
| `isLeaf`           | 1 when file is a leaf                                          | file   |
| `transitiveImpact` | Normalized count of transitive importers                      | file   |
| `chunkFanIn`       | Normalized method-level fan-in                                | symbol |
| `chunkFanOut`      | Normalized method-level fan-out                               | symbol |
| `pageRank`         | Normalized PageRank (recursive importance)                    | symbol |

## Configuration

| Variable                          | Default   | Description                                                                                  |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `CODEGRAPH_ENABLED`               | `false`   | Master switch for the codegraph trajectory family (beta). `true` enables extraction, signals, and tools. |
| `CODEGRAPH_DB_PATH`               | data dir  | Override the graph-DB root directory. Per-project files at `<rootDir>/codegraph/<collection>.duckdb`. |
| `CODEGRAPH_DB_MEMORY_LIMIT`       | `"2GB"`   | Per-project DuckDB RAM ceiling before spilling to a temp dir (prevents OOM on large repos). |
| `CODEGRAPH_DB_THREADS`            | `2`       | DuckDB worker threads per project. The writer lock — not parallel scan — is the bottleneck, so more threads inflate memory without speeding up. |
| `CODEGRAPH_CUSTOM_EXCLUDE`        | _(empty)_ | Comma-separated `.gitignore`-shaped patterns added to the exclusion filter, e.g. `vendor/**,generated/**,*.pb.go`. |
| `CODEGRAPH_AMBIGUOUS_RESOLVE_MODE`| `"strict"`| How to resolve short-name calls matching multiple candidates. `strict` drops the edge unless exactly one match; `first` picks the first candidate (higher recall, more noise). |

Test files and generated files are always kept out of the graph, and that is not
configurable. A test calls production code and nothing calls it, so its edges
inflate the fan-in and PageRank of whatever it touches without describing any
real dependency. Both kinds are still indexed by Qdrant and stay searchable —
only graph extraction skips them.

## Next Steps

- [Git Enrichments](/usage/advanced/git-enrichments) — the history-based signal
  family codegraph composes with
- [Code Quality Metrics](/knowledge-base/code-quality-metrics) — fan-in/fan-out,
  instability, and centrality theory with research references
- [MCP Tools Atlas](/usage/advanced/mcp-tools) — full tool reference including
  `get_callers`, `get_callees`, `find_cycles`, `find_symbol`
- [Configuration Variables](/config/environment-variables) — full list of all
  configuration options
