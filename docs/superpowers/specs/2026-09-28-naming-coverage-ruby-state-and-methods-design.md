# Naming coverage: Ruby class state and untyped methods

Epic parent: bd tea-rags-mcp-0qaht (naming lexicon hardening). Follows the
language-namespace evidence fix (`a8edfcb57`); every read below is scoped to
the draft's language namespace. Swift constants are a later, separate slice.

## Problem

`get_naming_lexicon` and `get_ontology_report` judge only the declarations the
language walkers persist to `cg_identifiers`. Three Ruby-relevant declaration
forms never reach it, and one declaration class is never judged:

| Form | Today | Where it dies |
| --- | --- | --- |
| `@@cache = {}` (class variable) | invisible | `ruby/walker/passes/identifier-declarations.ts`: `ASSIGNMENT_KIND_BY_LEFT_TYPE` maps only `identifier` / `instance_variable`; no `class_variable` anywhere under `ruby/` |
| `@x ||= compute` / `@@x ||= {}` (memoization) | invisible | `operator_assignment` is skipped by design, together with `+=` |
| `attr_reader :document` (and writer / accessor, `cattr_*`, `mattr_*`) | synthetic METHOD symbols in `cg_symbols` only | `walker/macro-expansion.ts#expandClassBodyMacros` feeds the codegraph, never the identifier pass |
| a method with no inferable return type | no `return` row; diff review reports it as `notJudged.unknownReturnType`; a `names[]` return draft without `type` gets a bare `NEW_TERM{topTerms: []}` | `kernel/identifier-declarations.ts` drops an unannotated return; `verdicts.ts#judgeByNameUse` is the only fallback |

Diff mode reuses the index-time path (`createNamingReviewExtractor` →
`extractFileInMemory` + `buildIdentifierRows`), so whatever the walker starts
emitting is reviewed without extra wiring. `cg_identifiers.kind` is a plain
`VARCHAR`; no migration is needed for any of this.

## Decisions

### D1. Class variables are `field`, named with the sigil

`class_variable` joins `ASSIGNMENT_KIND_BY_LEFT_TYPE` as `field`; the row name
keeps `@@` exactly as ivar rows keep `@` (`@document`). The ontology collision
key already strips `^(@@|@|\$)`.

Rejected: a new kind (`classField`). It costs `KIND_ROLE`, the MCP zod enum,
`naming.casing[role]` in every language descriptor, `concept_all`'s kind list,
`OntologyValueKind` and `FREE_CHOICE_KINDS` — about ten wiring points — and
buys no verdict difference: a class variable names state exactly as an ivar
does, with the same casing.

### D2. `||=` declares; other compound assignments do not

`operator_assignment` whose operator is `||=` is read as a declaration of its
left side, with the same left-type → kind map as `assignment` (identifier →
`local`, instance_variable / class_variable → `field`). `+=`, `-=`, `&&=` and
friends stay skipped: they update a binding that was declared elsewhere. Type
recovery is unchanged (`X.new` on the right, then `fieldTypeOf`, then finder).

### D3. Accessor macros declare fields, driven by the DSL catalogue

The identifier pass reads accessor macros from the DSL catalogue entries whose
`category` is `"accessor"` (`dsl/ruby-core.ts`, `dsl/activesupport.ts`), never a
hard-coded name list — the catalogue stays the single source. Each symbol / string
argument declares one `field` row:

- instance accessors (`attr_*`) → `@name`
- static accessors (`cattr_*`, `mattr_*`) → `@@name`

The owner is the innermost chunk, as for every row. The type comes from
`recoveredType` through `fieldTypeOf`, which already looks under both `@x` and
`x`; `attr_reader :document` beside `@document = Document.new` therefore reads
back typed. An accessor and an ivar assignment in `initialize` are two rows with
two owners — two declarations, counted as such.

### D4. Untyped methods are judged by the project's method vocabulary

A method whose return type is unknown becomes a draft `{ kind: "return", name }`
with no `type`. In diff mode it leaves `notJudged` (the `unknownReturnType`
reason disappears for methods); in names mode the bare `NEW_TERM` fallback is
replaced. Typed return drafts keep today's verb + type judgement untouched.

Evidence — declared method and function short names in the answer's scope and
language namespace, production paths only. The judgement never needs the
project's whole method list, so the aggregation is pushed into SQL and the
answer size is bounded by the verb lexicon and the drafts, not by the project:

| Slice | SQL shape | Rows back |
| --- | --- | --- |
| verbs of a noun tail (`…_user`, `…User`) | `regexp_matches(short_name, <pattern>)`, patterns built from the tail words in each namespace language's method casing; all drafts' tails in one batched read | names carrying those tails only |
| the project's verb vocabulary | `GROUP BY` the first word (`split_part` for snake, `regexp_extract('^[a-z]+')` for camel) `WHERE` it is `IN (NAMING_VERB_PREFIXES)` | ≤ the verb lexicon (~100) |
| verbless names sharing a last word (`total`) | `LIKE '%\_total'` / `'%Total'`, batched | matches only |

```ts
// contracts: codegraph-storage.ts
interface MethodNameScope extends IdentifierScopeQuery { // pathPrefixes, excludePaths, languages
  nonProductionPaths: NonProductionPathPatterns;
}
interface MethodVerbRow { verb: string; holders: number }                 // vocabulary slice
interface MethodNameRow { shortName: string; holders: number }            // tail / last-word slices
readMethodVerbs(q: MethodNameScope & { verbs: readonly string[] }): Promise<MethodVerbRow[]>
readMethodNamesMatching(q: MethodNameScope & { patterns: readonly MethodNamePattern[] }): Promise<MethodNameRow[]>
```

`holders` = distinct symbol ids. Both reads live in `identifier-store.ts`
beside `existingSymbolShortNames` (its other `cg_symbols` read), filter
`symbol_kind IN ('method', 'function')`, exclude constructors and operator
methods, and are carried through client, daemon protocol, op-commands and
daemon client like every identifier read. The vocabulary slice is memoized per
request (as `alignment.typeNameRows` is), since diff mode answers once per
language; nothing is cached across requests — a reindex would make such a cache
stale. Rejected: an index-time `cg_method_verbs` table — a new table, schema
bump and write path for a cost the read-side pushdown already removes.

Judgement — a pure function in a new module
`domains/explore/naming-lexicon/method-vocabulary.ts` (not in the ops class,
which is already 2 100+ lines):

1. Split the draft into words (`casing.ts`), drop a trailing `?` / `!` for
   matching and keep it in suggestions.
2. The draft's first word is a verb when it is in `NAMING_VERB_PREFIXES`.
3. Verbless draft (`total`, `document`) → CONFORMS when the name is declared
   elsewhere in scope, otherwise `NO_CONVENTION { prefer: { analogous } }` with
   the top verbless names sharing its last word. Accessor-style names carry no
   verb vocabulary to judge. This is the one `return` path that yields
   `NO_CONVENTION`; `FREE_CHOICE_KINDS` stays value-only, and the review counts
   it as novel like any other `NO_CONVENTION`.
4. Verbed draft, noun tail `N` (the words after the verb):
   - project methods with tail `N` exist and one verb holds ≥ 50 % of their
     holders with ≥ 2 holders, and the draft's verb differs →
     `MISFIT { suggestion: <that verb> + N, holder }`;
   - else the draft's verb is among the project's verbs (≥ 2 holders) →
     `CONFORMS`;
   - else `NEW_TERM { topTerms: <top project verbs> }`.
5. Casing of suggestions: the draft's own casing (`joinIdentifierWords`).

Thresholds reuse the existing minima (`MIN_ROLE_MEMBERS = 2`, the 0.5 dominance
share used by `supportedReturnVerb`); no new tuning constants.

### D4a. The verb lexicon is derived from the corpus, not listed

Amendment (bd tea-rags-mcp-tfhop, user decision 2026-09-28). The first cut of
D4 reused `NAMING_VERB_PREFIXES` as "the verbs". That list is a closed class of
accessor / factory verbs — words saying how a value is obtained, whose noun IS
the return (`find_user : User`). Its roles in `VERB_TYPE`,
`calleeDerivedWords` and `returnNounWords` stay. As a method vocabulary it is
wrong: `update_user`, `send_email`, `can_resolve?` fell into the verbless
branch and no tail dominance was ever computed for them.

A head word `w` of multi-word method / function names is a verb of the
project's language namespace when both hold:

- `headTails(w) >= MIN_ROLE_MEMBERS` — `w` opens names with at least two
  distinct noun tails (tail normalized across casings, `!` / `?` dropped);
- `headHolders(w) > lastHolders(w)` — `w` opens names more often than it ends
  them. `update` heads dozens of tails and rarely ends a name; `user` is the
  reverse.

No new constant: the minimum and the majority are the ones D4 already uses.
Predicate heads (`is`, `has`, `can`) and converters (`to`) qualify on the same
evidence, which is correct for a method vocabulary.

Reads, all bounded:

| Read | Shape | Rows back |
| --- | --- | --- |
| `readMethodHeadWords` (replaces `readMethodVerbs`) | head = leading lowercase run before `_` / an uppercase letter; `GROUP BY head HAVING count(DISTINCT tail) >= ?`; `lastHolders` computed in the same statement only for those candidate heads | candidate heads (hundreds) |
| `readMethodNamesMatching` (tail / last-word slices, unchanged) | tail pattern no longer enumerates verbs: `^[a-z][a-z0-9]*(?:_tail|Tail)[!?]?$`; heads filtered by the lexicon in TS | names carrying the draft tails |
| `readMethodTailVerbs` (ontology `verbs` section) | `(tail, head, holders)` for lexicon heads, only tails with `count(DISTINCT head) >= 2` | contested tails only |

The lexicon is memoized per request like the vocabulary slice was. The
judgement functions take it as a parameter (`methodVerbOf(name, lexicon)`);
`method-vocabulary.ts` no longer imports `NAMING_VERB_PREFIXES`.

The accessor class itself can be derived too (a `w_X` whose return type spells
`X` in a majority) — separate slice, bd tea-rags-mcp-6tu7q, since it moves
`verdicts.ts` behaviour.

### D5. `get_ontology_report` gains a `verbs` section

D1–D3 rows reach the existing sections by themselves once they carry a type:
`concept_all` reads `field` rows with `type_name IS NOT NULL`. Untyped rows stay
out, as every untyped value does today — the report is organised by type
concept.

Methods get a new opt-in section `verbs`: per noun tail, the verbs the project
uses with holder counts, and the deviants D4 would call MISFIT (`fetchUser`
among `load*User`). It is computed by the same `method-vocabulary.ts` functions
over the same `readMethodVerbs` / `readMethodNamesMatching` reads, grouped per
language namespace — no
second implementation. Sections enum, DTO (`api/public/dto/ontology.ts`) and the
MCP schema list gain `"verbs"`; the tool description budget (300 chars / 1536
bytes) is measured, never raised.

## Affected code

| Area | Files |
| --- | --- |
| Ruby walker | `ruby/walker/passes/identifier-declarations.ts` (+ catalogue lookup), `ruby/capability.ts` walker 5 → 6, `tests/core/domains/language/capability/version-pins.json` |
| Storage | `contracts/types/codegraph-storage.ts`, `adapters/duckdb/identifier-store.ts` (beside `existingSymbolShortNames`, its other `cg_symbols` read), `duckdb/client.ts`, `daemon/{protocol,op-commands,client}.ts` |
| Lexicon | new `explore/naming-lexicon/method-vocabulary.ts`, `verdicts.ts` (return without type), `api/internal/ops/naming-lexicon-ops.ts` (review drafts for untyped callables, evidence read) |
| Ontology | `api/internal/ops/ontology-report-ops.ts`, `api/public/dto/ontology.ts`, `src/mcp/tools/` sections enum |
| Guidance | `src/mcp/resources/registry.ts` overview, DDG Step 5, `mr-review` (verbs section), plugin patch bumps |

## Testing

TDD per slice, red first:

- Walker: `@@x = …`, `@x ||= …`, `@@x ||= {}`, `x += 1` (still skipped),
  `attr_reader :a, :b`, `attr_accessor "c"`, `cattr_reader :d` → exact rows
  (kind, name, owner); typed accessor through `fieldTypeOf`.
- Store: `readMethodVerbs` / `readMethodNamesMatching` honour prefix, language,
  exclusion, non-production and kind filters; snake and camel patterns match
  `load_user?` / `loadUser`; the verb slice returns only lexicon verbs.
- Judgement: every branch of D4 as a pure-function table test.
- Ops: diff review of a Ruby file with an untyped `fetch_user` among
  `load_*_user` methods → MISFIT finding, no `unknownReturnType` entry; names
  mode return draft without type.
- Ontology: `verbs` section on a fixture; absent unless requested.

## Validation (user-gated)

Walker 5 → 6 marks every Ruby index stale for codegraph. Baseline first, then
`DEBUG=1 node build/cli/index.js index-codebase --project <ruby corpus>
--force-enrichments codegraph --languages ruby --json` under the heavy-measure
lock, and compare: `cg_identifiers` field rows before/after, a `get_naming_lexicon
changes/files` review on a Ruby file with accessors and memoization, and the
`verbs` section. Corpus: a registered Ruby project (mastodon or taxdome), since
the tea-rags self-index holds little Ruby. Wall-clock of `readMethodVerbs` and
`readMethodNamesMatching` recorded on the largest corpus: both return bounded
rows, but regex / suffix `LIKE` cannot use `idx_cg_symbols_short`, so the
residual cost is one filtered scan of `cg_symbols` per read.

## Out of scope

- Swift constants (`static let`, file-scope `let`) — next slice.
- TypeScript constructor parameter properties and Python class-body
  annotations, both persisted today as `param` / `local` although they declare
  fields — filed as a separate bead.
- Cross-language naming view — bd tea-rags-mcp-wponu (P4).
