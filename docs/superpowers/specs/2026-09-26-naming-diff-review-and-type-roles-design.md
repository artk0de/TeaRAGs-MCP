# Naming review over a diff, type-name roles and term alignment

Beads: `tea-rags-mcp-fdef2` (diff-time naming review), `tea-rags-mcp-vi0wx`
(type, module and constant names). Parent epic `tea-rags-mcp-4p3sb`. Extends
`2026-09-24-naming-lexicon-design.md`.

## Goal

The naming lexicon answers one question at three scales: what name would THIS
codebase give to this thing.

| Scale           | Tool                                | Status    |
| --------------- | ----------------------------------- | --------- |
| write-time      | `get_naming_lexicon` with `names[]` | shipped   |
| diff-time       | `get_naming_lexicon` with `changes` | this spec |
| repository-time | `get_ontology_report`               | shipped   |

Two gaps close here. An agent adding a class, module, interface, enum or
constant gets no judgement today, because `cg_identifiers` holds value
identifiers only. And a change the agent already wrote is never reviewed against
the vocabulary unless the agent re-lists every name by hand.

## Non-goals

- Declared naming policy (a rules file the tool enforces). Naming rules are
  configured in the agent; the tool judges style and reuse of the project's
  existing domain terms, both derived from the code.
- Architecture norms. `tea-rags-mcp-xb669` (another session) consumes the type
  roles defined here; its contract is in "Handoff to xb669".

## 1. Symbol kind in the codegraph

`cg_symbols` has no kind column: a class and a top-level function are both a
bare `symbol_id`. Guessing from members or inheritance misses member-less types
and misreads PascalCase functions (Go exported functions, Python factories).

- Migration 035 adds `cg_symbols.symbol_kind VARCHAR`:
  `class | module | interface | enum | type_alias | constant | function | method`.
  NULL on rows written before the migration; readers treat NULL as unknown and
  exclude it from type-name judgement rather than guessing.
- Each language walker writes the kind from the node type it already visits, on
  the chunks it already emits. No declaration becomes a NEW symbol: a codegraph
  symbol needs a chunk with the same symbolId, and the chunker gives small type
  declarations (TS `type` / `interface` / `enum`) no chunk of their own and
  module-level constants none at all. Type and constant names travel in their
  own channel instead (§1b).
- Versions: walker axes are already above `main` for every language this release
  cycle, so no bump, only a re-pin; a codegraph recompute
  (`--force-enrichments codegraph`) rewrites `cg_symbols`.

## 1a. Kind roles in call resolution (`jqvbn`)

Once definitions carry a kind, a lookup for a CALLEE must not return a
definition that cannot be called, and a same-named type must not count as a
namesake. Which kinds can be called is a property of the LANGUAGE, not of the
kind vocabulary: Ruby never calls a class by its bare name (`Money(x)` is a
method, the class is only a receiver of `.new`), Go calls interfaces and type
aliases (`Stringer(x)` is a conversion), Swift and Python call enums
(`Color(rawValue:)`, `Color(1)`).

- Each language capability declares
  `symbolKindRoles: { callee: ReadonlySet<SymbolDefinitionKind>; receiver: ReadonlySet<SymbolDefinitionKind> }`.
  The symbol table applies the CALLING file's policy to `lookupByShortName`,
  `lookup(fq)` and `shortNameDefCounts`. A lookup with no role is a type lookup
  and keeps every kind. An untagged definition (NULL kind) serves every role.
- Per language (callee / receiver):

| Language | class | module | interface / protocol / trait | enum | type_alias | constant |
| -------- | ----- | ------ | ---------------------------- | ---- | ---------- | -------- |
| TS / JS  | C R   | R      | —                            | R    | —          | R        |
| Java     | C R   | —      | R                            | R    | —          | R        |
| Swift    | C R   | —      | R                            | C R  | C R        | R        |
| Go       | C R   | R      | C R                          | —    | C R        | R        |
| Rust     | C R   | R      | R                            | R    | —          | R        |
| Python   | C R   | R      | —                            | C R  | C          | R        |
| Ruby     | R     | R      | —                            | —    | —          | R        |
| Bash     | —     | —      | —                            | —    | —          | —        |

`function` and `method` are C R everywhere they exist. A static interface member
call (`Comparator.naturalOrder()`) makes the interface a receiver. A Rust call
spelled with an enum's name builds a variant (`Style(s)` is a tuple variant or
struct, never `enum Style`), so a Rust enum is a receiver only. A Ruby constant
reference (`receiver === member`, e.g. an association class) looks up with the
receiver role.

- The first cut (commit on `worktree-naming-waves`) used one language-agnostic
  predicate and opted in TS/JS and Rust only. This table replaces it; Go, Swift,
  Java and Ruby join through their capability, not by being skipped.
- Gate per language: `codegraph-chain-tally --time-only --kind-stats` before and
  after on that language's corpus. A lost edge is inspected; it may only go if
  it was wrong.

## 1b. Type and constant declarations, every language

`FileExtraction.typeDeclarations` (`TypeDeclarationFact`) already exists and
only the Swift walker fills it, for the Swift resolver. It is generalized
instead of adding a second channel.

- The fact gains `symbolKind: SymbolDefinitionKind` and `line`. Swift's
  `declarationKind` stays as Swift detail. `supertypes` / `conforms` carry the
  ancestors, so roles read no join.
- Every walker emits one fact per type-level declaration and per file-level
  constant, whether or not it is a chunk or a symbol:

| Language   | Declarations                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| TypeScript | class, interface, type alias, enum, exported/top-level `const` that is not function-valued                |
| JavaScript | class, top-level `const` that is not function-valued                                                      |
| Python     | class (Enum subclass → enum), `X: TypeAlias` / `type X =` / `NewType`, module-level UPPER_CASE assignment |
| Ruby       | class, module, constant assignment                                                                        |
| Go         | struct / defined type (class), interface, alias, package-level `const`                                    |
| Rust       | struct / union (class), enum, trait (interface), `type`, `const` / `static`, `mod`                        |
| Java       | class, record (class), interface, annotation (interface), enum, `static final` field                      |
| Swift      | class / struct / actor (class), protocol, enum, typealias; extensions stay `reopens: true`                |
| Bash       | none                                                                                                      |

- Resolution keeps what it reads today: run-state hydrates `typeDeclarations`
  only for languages whose resolver reads them (a capability flag), so the new
  facts of other languages do not enter the run-global maps.
- Persistence: migration 038 adds
  `cg_type_declarations(rel_path, language, type_id, short_name, symbol_kind, line, reopens, supertypes VARCHAR[])`,
  replaced per file at flush and deleted with the file, like `cg_identifiers`.
- `readTypeNameRows` (§2) reads `cg_type_declarations` (`reopens = false`) as
  its single source, for every language.
- Diff mode takes type and constant drafts straight from the in-memory
  extraction's `typeDeclarations`.

## 2. Type roles

A role is the suffix a family of types shares (`…Strategy`, `…Preset`,
`…Store`). Granularity is the TYPE; a file's role is the dominant role of its
top-level types.

Evidence, strongest first (owner decision: inheritance primary, directory
secondary):

1. **Inheritance family.** Types with a common ancestor in
   `cg_symbols_inheritance` whose names share a tail word: that word is the
   family's role. `extends SymbolResolutionStrategy` → `…Strategy`.
2. **Directory.** A tail word carried by the primary types of ≥ 2 files of one
   directory, with a share ≥ 0.2 (the lexicon's shape-share bar) of the
   directory's files that have a primary: the directory's role.
3. **Project suffix.** A tail word carried by the primary types of ≥ k files in
   ≥ 2 directories. Filters one-off coincidences. k starts at 3 and is measured
   on the corpora below. The project suffix only CONFIRMS: a draft whose last
   word is one is CONFORMS on the role axis, and a draft whose last word is not
   one falls through to term alignment. It never produces MISFIT, because a
   suffix popular elsewhere with no inheritance or directory anchor is a guess,
   not an expected role.

Directory and suffix evidence read ONE type per file, its primary: the type
whose words overlap the file stem's words most, with a trailing plural
normalized on both sides (`errors.ts` matches `*Error`). A tie, or no overlap,
goes to the first type declared. So one `errors.ts` of ten `*Error` classes is
one file's convention, and a `RerankOptions` beside `Reranker` belongs to
reranker.ts's subject, not to a role. Inheritance evidence reads every type.

Roles are computed at read time from `cg_type_declarations` (§1b) by one store
query behind a daemon op. They are not persisted: they are cheap aggregates, and
a stored copy would go stale on every incremental run.

## 3. Judging a type-name draft

The draft gains `kind: "type"` with `{ name, path, extends?, concept? }`. `path`
is the file the type will live in; `extends` its planned ancestor.

| Verdict   | When                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| MISFIT    | the family (via `extends`) or the directory (via `path`) has a role the name lacks; suggestion = name + role |
| COLLISION | the short name already exists as a type in another module (homonym risk, e.g. `Commit` vs `CommitInfo`)      |
| NEW_TERM  | no role evidence and no aligned term (section 4); carries `alternatives` when section 4 found candidates     |
| CONFORMS  | the name carries the role and its terms align                                                                |

Casing follows the file language of `path`, as for value names.

## 4. Term alignment: reuse the project's words

A name is split into slots: the HEAD (the tail words naming the entity, `Doc`)
and QUALIFIERS (the words before it, `Calculated`). Each slot is aligned with
the project's existing vocabulary.

**Head slot.** For one concept the project has a dominant spelling. If the
project writes `Doc` 200 times and `Document` 3, a draft `CalculatedDocument`
gets `…Doc`. Compared among heads of the same family or role.

**Qualifier slot.** The project's modifier vocabulary is the set of words that
stand before a head in type names. A modifier is ESTABLISHED when it combines
with several distinct heads in several directories (`PredefinedTemplate` in
`templates/`, `PredefinedField` in `fields/`).

A similar case is found by meaning, and the attempt is ALWAYS made:

1. The concept query is the agent's `concept` when given; otherwise the draft's
   own words (`calculated doc`); in diff mode, also the code of the chunk that
   encloses the declaration.
2. A semantic search over the index returns the code nearest to that concept.
3. Each established modifier gets a lift: its frequency in the returned code
   over its frequency in the project.
4. The draft's qualifier is not established, and an established modifier has
   lift above the floor → `alternatives: [{ word, heads, domains, lift }]`, for
   example
   `Predefined — PredefinedTemplate (templates/), PredefinedField (fields/)`.
5. Nothing clears the floor → a new concept: NEW_TERM with no alternatives. That
   is a legitimate outcome, not a failure.

The verdict stays soft (NEW_TERM + alternatives, never MISFIT). This is a
judgement by meaning, and the agent decides whether to reuse the term or
introduce a new one. The same alignment applies to value names
(`calculatedDoc`).

Known limit: when the semantic search does not retrieve the code where
`Predefined*` lives, no alternative is offered. Recall is bounded by the
embedding model; the live measurement below quantifies it.

## 5. Novel free names

A value draft of FREE shape that is not among the names the project already uses
for that type is NEW_TERM, with the type's top names as context (for
`x: SymbolDefinition`: `defs`, `candidates`, `fallback`). Before this spec it
was CONFORMS, because the shape share of FREE passed the 0.2 bar. A known free
name stays CONFORMS.

## 6. Diff mode (`fdef2`)

Input: `changes: { base?: string }` (default `HEAD`: working tree against HEAD,
untracked files included) or `files: string[]`. It is a third draft source next
to `names[]` and `concept`.

1. **Changed files.** `git diff --name-only <base>` plus untracked files,
   through the existing git CLI adapter. Capped at 200 files per call.
2. **Drafts.** Each changed file's working-tree text runs through its language's
   extraction in memory: the `identifierDeclarations` channel and the
   identifier-row builder for value names, and the symbol pass for type names.
   No indexing. A draft carries exactly what an agent would pass:
   `{ name, kind, type?, typeMultiplicity?, callee?, path, extends? }`.
3. **Hunk filter.** `git diff -U0 <base>` gives the added line ranges; a draft
   is judged only when its line is in one. Untracked files count whole.
4. **No self-confirmation.** Every evidence read (by type, by callee, generic
   names, roles, modifier vocabulary) takes `excludePaths` = the changed files.
   An incremental reindex or an auto-update run that already indexed the change
   can therefore not let a new misfit vote for itself.
5. **Output.** The conforming declarations are counted in a summary; only
   findings are listed, each with `file:line`. GENERIC is a value draft whose
   verdict carries the existing `genericName` caveat, even when it otherwise
   conforms:

```
Naming review (base: HEAD) — 42 declarations checked, 37 conform
MISFIT    src/x.ts:12   meta: GitFileSignals      → fileSignals  (computeFileSignals)
GENERIC   src/x.ts:30   result: ParseResult       13 unrelated types carry this name
NEW_TERM  src/y.ts:8    environment: FooContext   no precedent; type vocabulary: ctx, context
NEW_TERM  src/y.ts:21   CalculatedDoc             alternative: Predefined (templates/, fields/)
COLLISION src/y.ts:40   Commit (new class)        short name exists: src/git/commit.ts
```

## 7. Code placement

| Unit                              | Owner                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `symbol_kind` extraction          | each `domains/language/<lang>/walker`                                                |
| migration 035                     | `domains/maintenance/migration/database`                                             |
| role, head and modifier reads     | DuckDB adapter store + daemon op                                                     |
| role derivation, slot split, lift | pure functions in `domains/explore/naming-lexicon`                                   |
| diff reading                      | existing git CLI adapter                                                             |
| in-memory extraction              | `LanguageFactory` (factory encapsulates construction)                                |
| orchestration                     | `NamingLexiconOps`                                                                   |
| DTO + schema                      | `api/public/dto/naming-lexicon.ts`, `src/mcp/tools/codegraph.ts` (byte budget holds) |

Backbone touch points (tea-rags enrichment): `adapters/duckdb/client.ts` (fanIn
6, 49 commits), `daemon/op-commands.ts` and `daemon/client.ts` (bugFixRate
concerning). New daemon ops go through the existing protocol pattern and rebuild
`build/` before any integration test.

## 8. Consumers

- `mr-review` skill: naming as its eighth signal dimension, fed by diff mode.
- `data-driven-generation` skill: a naming-review step before commit.
- Both are plugin edits: minor plugin version bump.

## 9. Validation

- Unit: TDD per verdict; fixtures shaped like the live data (the GitFileSignals
  lesson: an assumed row shape hid a live defect).
- Live, on the tea-rags self-index and on taxdome (Ruby-scoped recompute):
  - role coverage: share of types with a role, per language;
  - a hand-checked sample of 30 role assignments (precision);
  - term alignment: 20 known reuse cases (a qualifier or head the project
    already uses for the meaning), how many produce the right alternative;
  - diff mode: a diff introducing `meta: GitFileSignals` into an ALREADY indexed
    file still reports MISFIT `fileSignals`.
- Recompute: `--force-enrichments codegraph` under the heavy-measure lock.

## Handoff to xb669

When `vi0wx` lands, message session 95aadf75 with:

- the role API: the daemon op and ops method names; roles are derived at read
  time from DuckDB tables, not a payload key;
- granularity: type; a file's role = dominant role of its top-level types;
- the measured role coverage and the sampled precision.

## Open risk

A write-time draft that spells the collection in `type` (`type: "Item[]"`) finds
no rows: the tool expects the element type plus `typeMultiplicity`. Diff mode is
immune (drafts come from the walker). The schema says so; whether to also parse
common collection spellings in the ops layer is decided after the live
measurement.
