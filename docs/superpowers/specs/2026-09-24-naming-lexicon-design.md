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
// { name, kind, line, ownerSymbolId, typeName?, typeSource? }
// kind: "param" | "local" | "field" | "return"
```

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
  line            INTEGER NOT NULL
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

### Size

Unmeasured. Earlier typed-only estimate for taxdome was 320–450k rows, 25–45 MB
against 287 MB of live codegraph data; storing untyped declarations too may
double or triple it. Phase 0 measures it offline, before any reindex.

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
  names?: { name, kind?, type? }[] } // at least one of types / anchors / concept / names
```

### Pipeline

1. **Scope.** `pathPattern` → `rel_path` filter. Support < 5 rows → widen to the
   parent directory, then to the project. The answer reports the scope used.
2. **Types.** `types` ∪ param/return types of `anchors` ∪ `names[].type` — one
   SQL.
3. **byType.** One GROUP BY over `cg_identifiers` (`type_name, kind, name`), top
   5 names per kind.
4. **Shapes.** Pure function over the rows through the language's
   `NamingConventionPorts` (`kernel/naming-convention.ts`, used in reverse):
   `EXACT` (`snake(T)`), `QUALIFIED` (`snake(T)_q`, checked to co-occur with a
   second binding of T in the same owner), `TAIL` (a suffix of `snake(T)`),
   `VERB_TYPE` (`find_` + `snake(T)` …, on `return`), `FREE`. Shares plus
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
             shapes, confidence }],
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

Tool schema description only ("how this project names values of type T / a
concept; verdict on draft names"). No row in `search-cascade.md`: the call
belongs to DDG, not to general search. `plugin-guidance-layers.md` decides if
that changes.

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
