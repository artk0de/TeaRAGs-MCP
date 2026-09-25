# Naming Lexicon — Design

- **Date:** 2026-09-24
- **Base:** `worktree-mass-wave-0923` @ `186ff1964` (integration branch)
- **Related program:** `tea-rags-mcp-89k7k`, epic D `tea-rags-mcp-jwjyr`
  (substrate for D0 / D2, naming for D1 output)
- **Status:** design approved section by section; plan not written yet

## Problem

Agents writing code through `tea-rags:data-driven-generation` (DDG) bring their
own ontology. Observed failure on taxdome (reported, not yet reproduced by an
eval):

```ruby
row = find_vendor_envelope(id)
def find_vendor_envelope; TaxAutomationDocument.find(id); end
```

The project names that value `tax_automation_document`, the finder
`find_tax_automation_document!`, and a second binding of the same type in one
scope gets a qualifier suffix (`tax_automation_document_ignored`). The agent's
names carry no type and invent a term (`vendor envelope`) the project does not
use. It also costs the codegraph: the Ruby resolver types receivers from their
names (`conventionReceiverType`), so `row.provider` loses an edge that
`tax_automation_document.provider` would have produced.

The goal is not a rule the agent follows literally. The agent must see how THIS
project names things — locals, params, fields, finders, classes — and introduce
a new term only when the concept is new.

Today DDG does not check naming at all. Step 7 VERIFY checks that referenced
identifiers exist (`find_symbol(metaOnly)`, 0 hits = hallucination), which specs
already catch; it spends tokens without catching the defect above.

## Two problems, two mechanisms

1. **A value of known type** (local, param, field, method with known return):
   its name is a function of the type in this project. The invented word is not
   a query — the type is. Deterministic aggregation over the codegraph answers
   it; semantic search adds only noise.
2. **A new concept with no type anchor** (new class, module, service): the
   invented term must be mapped to the project's existing term. That mapping
   needs semantics — keyed on a DESCRIPTION of what the name denotes, never on
   the draft name itself (the draft would pull in its own lexical neighbours).

One MCP tool serves both, so the agent gets one vocabulary source.

## Substrate — identifier declarations in the codegraph

### Channel

`FileExtraction` (`contracts/types/codegraph-extraction.ts`) gains one channel:

```ts
identifierDeclarations: IdentifierDeclaration[]
// { name, kind, line, ownerSymbolId, typeName?, typeSource?, boundCallee? }
// kind: "param" | "local" | "field" | "return"
// boundCallee: { member, receiver? } — the OUTERMOST call of the value a
//   local / field is bound to (`x = find_x!(id)` → { member: "find_x!" },
//   `row = Doc.find(id)` → { member: "find", receiver: "Doc" }). Absent for
//   params and for values that are not a call.
```

Untyped declarations are most of the corpus (Phase 0: 91.7% of taxdome), and the
value they are bound to is what makes them usable — see "Type recovery".

`kind` belongs to the declaration because it is a syntactic fact, universal
across languages. `LocalBinding` (`contracts/types/codegraph-local-binding.ts`)
gains only `source: string` — the provenance of an inferred type, so a joined
type carries its rank. Producers must set it (required on the producer side).

### One kernel pass, one declarative object per language

`createIdentifierDeclarationFacetPass(syntax)` in `domains/language/kernel/` is
appended LAST to every `<LANG>_EXTRACTION_PASSES` (all nine lists exist today,
including the empty ones). A language contributes only an
`IdentifierDeclarationSyntax` object:

| Field                     | Purpose                                     |
| ------------------------- | ------------------------------------------- |
| param node types          | declarations of parameters                  |
| local node types          | assignments / `let` / `:=` / declarators    |
| field node types          | ivars, class properties, struct fields      |
| type annotation (opt.)    | syntactic type of the declared name         |
| constructor shapes (opt.) | `X.new`, `new X()`, `X()`, `&X{}`, `X::new` |

Adding a language = filling this object. No walk code, no resolver change. Exact
node type names come from each grammar at implementation time.

Type is filled in the same pass, strongest first:

1. syntactic — annotation or constructor call (one rule, all languages);
2. joined from channels the language already publishes: `localBindings` by name
   and nearest preceding line (carries `source`), `ivarTypes` /
   `classFieldTypes`, `structuredReturnTypes`;
3. otherwise `typeName` stays empty — the declaration is still recorded.

Owner = innermost enclosing chunk, the same rule as
`assignBindingsToInnermostChunks`.

`seedParamLocalBindings` (pass-2, `call-arg-param-types.ts`) marks what it seeds
with `source: "call-arg"`.

The new channel gets its row in the `kernel/merge-extraction.ts` rulebook (the
mapped type makes a missing row a compile error).

### Type recovery (amendment 2026-09-25, after Phase 0)

Phase 0 measured 8.3% of taxdome declarations typed syntactically (Ruby 2.3%).
Untyped rows stay in the table; four recovery stages type them, strongest first.
Each stage writes its own `typeSource`, so the lexicon reports evidence per
source and a stage can be switched off without a reindex.

| #   | Stage          | `typeSource`    | Where                          | Rule                                                                                                                                                                                                                                                        |
| --- | -------------- | --------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | resolver fact  | `binding`       | row builder (sink)             | the owner chunk's `localBindings` / `ivarTypes` / `classFieldTypes` — types the resolver chain already builds                                                                                                                                               |
| 2   | finder         | `finder`        | row builder (sink)             | `boundCallee.receiver` is a constant and `member` is in the language's finder vocabulary (Ruby: `find`, `find!`, `find_by`, `find_by!`, `first`, `last`, `take`, `create`, `create!`, `find_or_create_by`, `find_or_initialize_by`) → the receiver constant |
| 3   | callee return  | `call-return`   | lexicon query (join)           | the row's `bound_call_expression` joins `cg_symbols_edges_method` (`edge_kind = 'exact'`, one target) → the target's `return` row in `cg_identifiers`                                                                                                       |
| 4   | name inference | `name-inferred` | lexicon query, never persisted | a name typed ≥ 3 times in scope with one type holding ≥ 80% of those rows lends that type to its untyped occurrences                                                                                                                                        |

Stage 3 is a query-time join rather than a write-time copy: an incremental
reindex that changes a callee's return type is visible at once, and nothing is
rewritten in the caller's file. The row builder makes the join exact by copying
`CallRef.callText` — found in the same file's extraction by
`(startLine, member, receiver)` — into `bound_call_expression`, the same text
the edge table keys on.

Stage 4 is a statistic over observed rows, not the `snake(T) == name`
convention, so it does not break the invariant below — but it is never
persisted, and its rows are counted apart (`inferred`) so a reader sees how much
of an answer rests on it.

Normalization. The row builder strips a leading `::` from Ruby type names
(`::System` → `System`). Collection annotations are unwrapped to the element by
the WALKER in every language (`list[Job]` → `Job`, `Job[]` → `Job`, `Array<Job>`
→ `Job`, `Vec<Job>` → `Job`) — Go, Java and Swift already do, Python and
TypeScript are aligned in Task 3e, because Phase 0 showed Python's top type name
was `list`. No collection flag: the shape classifier accepts the plural of
`snake(T)` as `EXACT`. Primitive and top types (`string`, `number`, `boolean`,
`int`, `str`, `bool`, `unknown`, `any`, `Any`, `object`, `T`-style single-letter
generics) are recorded but excluded from `byType` — Phase 0's TS top three were
primitives.

### Naming convention in the language descriptor (amendment 2026-09-25)

Casing is a static fact of the language, owned by the substrate — not a table
inside the lexicon. `LanguageCapability` (`contracts/types/language.ts`, one
descriptor per `<lang>/capability.ts`, aggregated by
`LanguageFactory.capabilities()`) gains:

```ts
type IdentifierCasing = "snake" | "camel" | "pascal" | "screamingSnake";
type IdentifierRole =
  "type" | "module" | "method" | "param" | "local" | "field" | "constant";
/** Per role: accepted casings, the FIRST is canonical (used to render a name). */
naming?: Readonly<Record<IdentifierRole, readonly IdentifierCasing[]>>;
```

Absent only for a language without identifiers (markdown); a test derives that
`naming` is declared exactly by the languages publishing
`identifierDeclarations`. Examples:

| Language | type / module | method, param, local, field | constant               |
| -------- | ------------- | --------------------------- | ---------------------- |
| Ruby     | pascal        | snake                       | screamingSnake, pascal |
| Go       | pascal, camel | camel, pascal (exported)    | camel, pascal          |
| TS / JS  | pascal        | camel                       | camel, screamingSnake  |

Sigils (`@`, `@@`, `$`, `self.`) and predicate / bang suffixes are not casing —
the lexicon strips them before classifying. A read-path fact: no walker bump,
`Versions: unchanged` with a re-pin.

### TS / JS in v1

Declarations: full coverage. Types: annotations and `new X()` only.
`const x = foo()` without annotation stays untyped — only the `ts.Program`
checker in pass-2 knows it. Wiring the checker in is a precision increment on
the same channel (one more type source), not a coverage gap. Deferred.

### Table

```sql
CREATE TABLE cg_identifiers (
  rel_path        VARCHAR NOT NULL,
  owner_symbol_id VARCHAR NOT NULL,
  kind            VARCHAR NOT NULL,   -- param | local | field | return
  name            VARCHAR NOT NULL,
  type_name       VARCHAR,
  type_source     VARCHAR,
  line            INTEGER NOT NULL,
  bound_member          VARCHAR,     -- boundCallee.member
  bound_receiver        VARCHAR,     -- boundCallee.receiver
  bound_call_expression VARCHAR      -- CallRef.callText, the edge-table join key
);
```

No primary key, no secondary index (migrations 018/019 dropped unearned ones;
per-file delete and GROUP BY over ~10^6 rows need none). Migration number = the
next free one at merge time — the integration branch ends at 029 and the
parallel DuckDB bloat fix may take 030.

### Write path

Channel → NDJSON spill → pass-2 → per-file buffer beside
`SymbolNodeFlushQueue#buffer` → per-file DELETE + INSERT. Deleted files go
through `CodegraphEnrichmentProvider#handleDeletedPaths` with `cg_symbols`. The
queue is shaped so epic D's D0 (`cg_symbols_edges_field`, field ACCESSES) lands
as a sibling relation on the same path; declarations and accesses stay separate
tables — different relations, different cardinality.

Whatever the bloat fix (in flight on the integration branch) decides for
per-file rewrites applies here unchanged.

### Invariant

No convention-derived type ever reaches `cg_identifiers`. Holds by construction
— walker type sources (Ruby:
`sorbet, rbs, yard, associations, draper, body-last-expr, ast`) contain no
naming-convention source; name→type inference lives only in the resolver — and
is pinned by a test, because a lexicon fed by its own convention would confirm
itself.

The recovery stages keep it. Stage 3 may read an edge the resolver typed through
a naming convention — but the convention then typed the RECEIVER, a different
name from the declaration being classified, so the declared name is still an
observation. Stage 4 is a frequency over observed rows, not a name→type rule,
and is never written.

### Size

Measured in Phase 0 (plan, "Phase 0 results"): taxdome 255,254 declarations, 39
MB naive upper bound before DuckDB dictionary compression, against 287 MB of
live codegraph data. The three `bound_*` columns add at most ~40% to that bound
on locals and fields. Untyped rows stay.

### Reindex

Every language's walker version bumps → drift routes to `--force`. Accepted.

## Tool — `get_naming_lexicon`

- **Does:** returns the project's naming vocabulary for given types / concepts
  and a verdict per draft name.
- **Owner:** read path over codegraph + Qdrant — `NamingLexiconOps` in
  `api/internal/ops/` (precedents `trace-path-ops.ts`,
  `architecture-report-ops.ts`); DTOs `NamingLexiconRequest` /
  `NamingLexiconResult` in `api/public/dto/`; pure logic in
  `domains/explore/naming-lexicon/`.
- **Registration:** `registerCodegraphTools` — absent when codegraph is off,
  like `get_callers`.

### Request

```
{ project | collection | path,
  pathPattern?, language?,          // language required when concept is set
  types?, anchors?, concept?,
  names?: { name, kind?, type?, callee?: { member, receiver? } }[] }
  // at least one of types / anchors / concept / names;
  // a draft's `callee` drives `byCallee` when its type is unknown
```

### Pipeline

1. **Scope.** `pathPattern` → `rel_path` filter. Support < 5 rows → widen to the
   parent directory, then to the project. The answer reports the scope used.
2. **Types.** `types` ∪ param/return types of `anchors` ∪ `names[].type` — one
   SQL.
3. **byType.** One GROUP BY over `cg_identifiers` (`type_name, kind, name`), top
   5 names per kind.
4. **Shapes.** Pure function over the rows, rendering `snake(T)` / `camel(T)`
   with the canonical casing the language descriptor's `naming` declares for the
   row's role: `EXACT` (`snake(T)`), `QUALIFIED` (`snake(T)_q`, checked to
   co-occur with a second binding of T in the same owner), `TAIL` (a suffix of
   `snake(T)`), `VERB_TYPE` (`find_` + `snake(T)` …, on `return`),
   `CALLEE_DERIVED` (a local / field named after its `bound_member` with the
   verb prefix and `!` / `?` dropped — `x = find_x!(id)` — decided from the name
   and the callee alone, so it classifies UNTYPED rows too), `FREE`. Rows carry
   their `typeSource`; stages 3–4 run here (see "Type recovery"). Shares plus
   confidence `(n/k)^2`. The convention is induced from the distribution, never
   assumed: a project that names by role returns a `FREE`-dominant answer.
5. **Concept** (optional). Explore semantic strategy, called in-process:

   | Parameter   | Value                                                              |
   | ----------- | ------------------------------------------------------------------ |
   | query       | `concept` only — never the draft name                              |
   | mode        | dense (`semantic_search`), not hybrid                              |
   | filter      | `{ presets: "production" }`                                        |
   | language    | target language (polyglot rule)                                    |
   | pathPattern | L2 (domain), widened to the project under 5 holders                |
   | rerank      | `{ custom: { similarity: 0.7, chunkFanIn: 0.15, fanIn: 0.15 } }`   |
   | limit       | 30, `metaOnly`, `fields: [symbolId, relativePath, parentSymbolId]` |

   Holders' symbolIds, namespaces and paths are split (CamelCase, snake, `::`),
   normalised to snake n-grams of length 1–3; term score = Σ holder score.
   Relevance leads; among relevant holders the referenced ones are canon.

6. **Names.** Homonymy (types bound to the name, one SQL), collision
   (`cg_symbols.short_name`), fit against step 4 →
   `CONFORMS | MISFIT { suggestion, holder? } | NEW_TERM { topTerms }`.

### Result

```
{ scope,
  byType: [{ type, kinds: { local, param, field, return: [{ name, n }] },
             shapes, confidence,
             evidence: { annotation, constructor, binding, finder,
                         "call-return", "name-inferred" } }],  // row counts per typeSource
  byCallee?: [{ member, receiver?, locals: [{ name, n }], shapes }],  // untyped path
  concept?: { terms: [{ term, score, holders: symbolId[≤3] }] },
  names: [{ name, verdict, suggestion?, evidence: { n, example } }] }
```

No code bodies.

### Failure modes

| Condition                    | Behaviour                                              |
| ---------------------------- | ------------------------------------------------------ |
| index predates the migration | `driftWarning` naming the reindex, not an empty answer |
| type with no history         | empty `byType`; names get `NEW_TERM`                   |
| embeddings unavailable       | steps 1–4 and 6 run; step 5 skipped with a notice      |
| codegraph off                | tool not registered                                    |

## DDG changes

Built on the integration branch's DDG: Prerequisites already take per-symbol
labels from `find_symbol(rerank, metaOnly=false)` (explore PG-2), and labels are
read from `rankingOverlay.{file,chunk}.<field>.label` — present only for fields
in the preset's `overlayMask`; raw values under `payload.git.*` are never
labelled (`28f7044d1`). Every preset choice below is made against the mask.

### Step 5 STYLE — one lexicon call

| DDG mode      | types                         | anchors             | concept          | names                     |
| ------------- | ----------------------------- | ------------------- | ---------------- | ------------------------- |
| CREATE        | template + reuse manifest     | template + manifest | yes (new symbol) | the new symbol            |
| EXTEND        | + container field types       | + container         | if a new method  | the new method            |
| MODIFY/hotfix | symbol signature + its locals | the symbol          | no               | new locals / methods only |

Why here: before REUSE there are no anchors; after GENERATE a check means a
second call and a rewrite. Locals are not planned in advance — `byType` sits in
context during generation, which prevents instead of detecting.

Back-edge: `concept` finds a holder REUSE missed → back to Step 4 (a missed
reuse, not a naming issue). `byType` becomes the vocabulary for Step 6.
Codegraph off → direct `semantic_search` with the step-5 parameters, concept
part only.

### Step 6 GENERATE

Names come from the vocabulary. A word outside it is `NEW_TERM` and gets a
one-line justification in the output.

### Step 7 VERIFY — reworked

Removed: identifier-existence check (items 1–2) and the template-declaration
Read (item 3) — specs catch both.

Added — risks of symbols the new code calls or changes (≤ 5, most central
first): `find_symbol(symbol, rerank: "criticalPath", metaOnly: true)`.
`criticalPath`'s chunk mask carries exactly `codegraph.chunk.pageRank`,
`codegraph.chunk.fanIn`, `codegraph.chunk.fanOut`, `bugFixRate`, `commitCount`;
`dangerous` masks file-level git fields only and would leave the chunk labels
unread. Reactions:

- `bugFixRate` critical on a callee → call it defensively; confirm a test pins
  the scenario;
- `pageRank` critical or `chunk.fanIn` central on a changed symbol → Step 8
  `get_callers` (already mandatory for MODIFY);
- reviewer routing stays in Step 5 (blame-owner table) — not repeated here.

Codegraph off → `rerank: "dangerous"`, file-level `bugFixRate` only.

Kept: N-th-way self-check (`find_similar`), `tests-at-risk` for MODIFY. Step 7
is the extension point for epic D's D4 post-generation structural check — one
verification hook, not two.

Plugin version: minor bump.

## Plugin surface

Amended 2026-09-25 (user: every skill that names or judges names uses the tool;
the schema is described compactly). Per `plugin-guidance-layers.md`:

- **Tool schema** — call contract only, ≤ 300-char description, one-line field
  descriptions, no examples; a test pins the budget (plan Task 9).
- **Search cascade** — one decision-tree row for naming intents, one prohibited
  pattern (judging a name by grep / by `semantic_search` on the draft), one
  fallback-chain row.
- **Skills** — DDG Step 5 holds the full reading procedure; mr-review (D8
  naming), refactoring-scan, explore and the dinopowers brainstorming /
  writing-plans / executing-plans / requesting- and receiving-code-review carry
  one call line plus what they read, and point back to DDG Step 5.

## Relation to program 89k7k, epic D

| Epic D item                   | What this feature gives                                        |
| ----------------------------- | -------------------------------------------------------------- |
| D0 field edges                | same write path; `field` declarations with types               |
| D2 Feature Envy               | typed locals/params — envy needs the type of the receiver      |
| D1 un-extracted sub-operation | the extracted unit's NAME comes from the lexicon               |
| D4 post-generation check      | shares the reworked Step 7 hook                                |
| E divergence (hypothesis)     | ≥ 2 concept holders with different names = cheap early channel |

Untested hypothesis, not in scope: many names for one type inside one class may
signal the type plays several roles, i.e. several responsibilities.

## Testing

TDD throughout.

- Kernel pass: one fixture per language → declarations with the right `kind`,
  `typeName`, `ownerSymbolId`. Language coverage derived from
  `<LANG>_EXTRACTION_PASSES` in `tests/navigator-enumerations.test.ts`, never
  enumerated in prose.
- Merge rulebook row for the new channel.
- Writer: per-file DELETE + INSERT, deleted paths, the no-convention-type
  invariant.
- `NamingLexiconOps` over an in-memory DuckDB fixture; pure shape classifier and
  term extractor.

## Validation (reindex user-gated)

1. **Phase 0, no reindex:** run the pass offline over taxdome; report row count
   and table size.
2. `--force` on tea-rags and taxdome;
   `get_naming_lexicon(types: ["TaxAutomationDocument"])` must show
   `tax_automation_document` dominant.
3. A DDG eval scenario reproducing `row = find_vendor_envelope(id)` must end in
   `MISFIT` → `tax_automation_document` / `find_tax_automation_document!`.

## Out of scope

- TS/JS checker-inferred types (increment on the same channel).
- D0 field-access edges (epic D).
- Role-divergence signal (hypothesis above).
