# Python Annotation Type Facet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Python a type-fact facet that reads what the source already
declares — PEP 484/526/604 annotations first, Google and Sphinx docstrings
second — and publishes it on the extraction channels the resolver chain already
consumes. `annotationReturn` is the largest single recall lever in the E0
baseline (2,955 losses, 2,186 of them polar) and `annotationParam` the narrow
half (149, carried by httpx and flask); today the chain reads neither, which is
why the most-annotated corpus in the set resolves worst.

**Architecture:** One `ExtractionFacetPass`, registered in
`PYTHON_EXTRACTION_PASSES`. The native walker is not re-sliced and keeps its
constructor inference; the pass runs after it and the append-only
`mergeExtraction` rulebook folds the result in, so the walker's answer always
wins a shared key. Inside the pass:
`PYTHON_INLINE_TYPE_SOURCES → TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER) → pythonTypeChannels`,
where `pythonTypeChannels` wraps the kernel's `typeFactChannels` and re-keys two
of its four channels onto the ones Python's strategies actually read. Everything
new is a pure function over a tree-sitter subtree or a docstring string.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harnesses (`scripts/codegraph-chain-tally.ts`,
`scripts/py-codegraph-jedi-oracle.ts`). All new code under
`src/core/domains/language/python/walker/passes/`. No kernel file is modified.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
(E2 seam 2, contract-spine row `TypeSource` + `ExtractionPass`; pull-order entry
3) — plus the Decision record below.

## Decision record

### E2 seam 2 — Python annotation type source (`9fgdi`)

**1. One facet pass; the monolith is not touched except to export its env
gate.** `python/walker/passes/annotation-type-facts.ts` exports
`pythonAnnotationTypeFacetPass: ExtractionFacetPass`, and
`PYTHON_EXTRACTION_PASSES` gains exactly that one entry. That is the whole
wiring change: `composeExtractionWalker` already runs
`extractFromPythonFile` first and folds each pass's `Partial<FileExtraction>`
through `mergeExtraction` (`kernel/extraction-passes.ts:74`). The one edit to
`walker/walker.ts` is renaming its private `localTypeTrackingEnabled` to
`pythonLocalTypeTrackingEnabled` and exporting it, so the pass reads the SAME
`CODEGRAPH_PY_LOCAL_TYPE_TRACKING` switch instead of a copy that could drift.
A rename plus an export is not a re-slice.

**2. The pass emits only coordinates the monolith declines — and the monolith
declines more than the seam brief assumed.** `collectLocalBindingsForChunk`
(`walker.ts:366`) already binds `typed_parameter` / `typed_default_parameter`
and PEP 526 `x: T`, and `collectPythonClassFieldTypes` (`walker.ts:201`) already
reads `self.x: T = …`. What kills all three is `extractTypeName`
(`walker.ts:447`): it returns a name for `identifier` and `attribute` and `null`
for everything else, so `Optional[Foo]`, `list[Foo]`, `Foo | Bar` and `"Foo"`
are dropped on the floor. That — not the absence of param reading — is the
149-loss `annotationParam` bucket, and it is why `x: Optional[Session]` types
nothing today. So the annotation source SKIPS a `param` / `local` coordinate
whose annotation is a bare `identifier` or `attribute`: the walker already wrote
it, `mergeLocalBindings` concatenates rather than dedupes
(`kernel/merge-extraction.ts:70`), and a duplicate binding at the same line on
polar's 80,619 annotated sites is pure payload. `ivar` and `return` facts have
no such gate — `unionNestedBaseWins` / `unionBaseWins` dedupe by key, so a
repeat costs nothing and the shape gate would only add a way to be wrong.

**3. Sources and ranks.**
`PYTHON_TYPE_SOURCE_ORDER = ["annotations", "docstring", "ast"]`. `ast` is
reserved for a future relocation of the walker's constructor inference into a
pass and is NOT implemented here — it exists in the constant so the rank is
decided once, in the open. `annotations` is this seam's primary source;
`docstring` covers Google `Args:` / `Returns:` and Sphinx `:type x:` / `:rtype:`
only, the two dialects the corpora carry (ugnest Google ×252, flask Sphinx
×230). The two sources are DISJOINT by construction — the docstring source
emits a param fact only for a param with no annotation node at all, and a return
fact only when `return_type` is absent — so the rank never fires in production.
It is a safety net for the day a third source overlaps, and Task 4 pins it with
a hand-built collision anyway. Both sources coordinate a param fact at the
enclosing `def` line, which is what makes a collision possible at all:
`coordinateKey` includes `line` (`kernel/type-fact-store.ts:80`), so two sources
that disagreed about the line would both survive instead of one outranking the
other.

**4. Only a single nominal arm becomes a receiver binding.** The mapper
implements the full `TypeRef` algebra (decision 3 of the seam brief), but
`param` / `local` / `ivar` facts are emitted only when
`typeRefReceiverForm(ref)` yields a `class` or `instance` form — one reachable
arm. `return` facts carry the algebra intact. The reason is the two channels'
different tolerance for imprecision. `LocalBinding.type` is a bare string, and
`TypeFactStore#localBindingsForChunk` flattens a container to its ELEMENT and a
union to its FIRST member (`type-fact-store.ts:24`, `:44`). Ruby can afford the
container unwrap because a YARD `@param x [Array<Post>]` documents a parameter
the body iterates; Python's `xs: list[Foo]` annotates the variable that is
itself the receiver, so `xs.append(y)` would resolve against `Foo` and
`PythonLocalBindingSymbolResolutionStrategy` would commit a file-only edge into
`Foo`'s file rather than dropping. The same argument covers a two-arm union: the
strategy reads `resolveLocalBindingType`, the string, so `Foo | Bar` would bind
`Foo` and half the sites would be wrong. `Optional[Foo]` and `Foo | None`
collapse to one arm and ARE emitted — that is exactly what
`typeRefReceiverForm` exists for (`kernel/type-ref.ts:96`).

**5. `typeFactChannels`' four channels are not Python's four channels.** The
kernel helper publishes `chunks[].localBindings`, `functionReturnTypes`,
`structuredReturnTypes` and `ivarTypes`. Python keeps the first, re-keys the
third, re-keys the fourth onto a different channel, and drops the second:

- `ivarTypes` → **`classFieldTypes`**. `PythonSelfFieldSymbolResolutionStrategy`
  reads `ctx.classFieldTypes?.[enclosing]?.[field]` where `enclosing` is
  `ctx.callerScope[callerScope.length - 1]`, a class SHORT name
  (`python-self-field.ts:34`). `ivarTypes` is keyed by
  `symbolScope.join("::")` with Ruby's leading `@` on the member; nothing on the
  Python side reads it, and emitting it would ship a dead nested Record through
  the NDJSON spill and the run-global absorb. So the adapter takes the last
  `::` segment as the class key and leaves the attribute name bare — the same
  key shape `collectPythonClassFieldTypes` already writes, which is what lets
  the merge dedupe the overlap instead of doubling it.
- `structuredReturnTypes` keys are rewritten from Ruby's `::` join to Python's
  symbolId convention, so the emitted key IS the callee's symbolId as
  `pyNameOf` + `DefaultSymbolIdComposer` compose it: `run` for a module-level
  def (`""` prefix ⇒ `localName`, `kernel/symbol-id.ts:22`), `Cls#method`,
  `Cls.method` for a `@classmethod` / `@staticmethod`, `Outer.Inner#method` for
  a nested class (`scopeSeparator: "."`, `python/kernel.ts:41`).
- `functionReturnTypes` is **dropped**. It is a FLAT map keyed by bare method
  name, absorbed run-global with last-write-wins
  (`trajectory/codegraph/symbols/run-state.ts:1068`). At Python's annotation
  density one `def get(self) -> Foo` would claim every `get` in the corpus; the
  store's own docblock names this hazard (`type-fact-store.ts:30`, bd h4hxh).
  The owner-qualified channel says the same thing without the collision.

`structuredReturnTypes` has no Python reader in this seam — verified, no file
under `python/` mentions it — so return facts are inert until the propagation
seam. They are emitted now because collecting them is the same walk, and
because that seam's first task should be reading a channel that is already
filled on five corpora.

---

## Global Constraints

- **Existing Python walker tests are not edited.**
  `git diff --stat -- tests/core/domains/language/python` must show only ADDED
  files after every task. `python-walker.test.ts`,
  `python-walker-inheritance-edges.test.ts` and `python-import-bindings.test.ts`
  pin the monolith; if one fails, the pass is writing where the walker already
  wrote (`.claude/rules/test-invariants.md`, `.claude/rules/resolver-architecture.md` §4).
- **No kernel file changes.** `kernel/type-facts.ts`, `type-fact-store.ts`,
  `type-fact-channels.ts`, `type-ref.ts`, `merge-extraction.ts` and
  `extraction-passes.ts` are consumed as they stand. If a task feels like it
  needs a kernel edit, the adapter belongs in `python/walker/passes/` instead —
  that is what decision 5 is. A kernel change is a separate seam with its own
  Ruby relocation gate.
- **NDJSON spill discipline.** Every value that reaches a `FileExtraction`
  channel is a plain `Record` / array. A `Map` or `Set` serialises to `{}` and
  loses every entry (`contracts/types/codegraph-extraction.ts:8-11`). `Map` as a
  local device inside a function is fine.
- **Emit only non-empty.** The pass returns `{}` when it has nothing, and never
  sets a channel to an empty object. An empty channel reaching the spill moves
  the payload the schema-drift guard compares. `mergeExtraction` also skips
  empty incoming channels (`carriesNothing`), so this is belt and braces — write
  it anyway, because the pass's own unit test asserts `Object.keys(out)` and
  that assertion is the readable one.
- **`localBindings` stays line-sorted and position-aware.**
  `resolveLocalBindingType` reads "greatest `line <= atLine`"
  (`src/core/domains/language/CLAUDE.md` → Invariants). Every param fact carries
  the enclosing `def` line, so a later `x = Foo()` from the monolith's
  constructor inference supersedes it at any call below the reassignment —
  that is Python's actual semantics and it costs nothing to get right.
- **`symbolId` is copied, never composed.** The pass reads `ctx.chunks` and
  `typeFactChannels` copies `chunk.symbolId` verbatim. A divergent id yields
  edges pointing at ids no chunk carries, with no error
  (`domains/language/CLAUDE.md` → Invariants).
- **Bare last segment, always.** A dotted annotation (`pkg.mod.Foo`) reduces to
  `Foo`. The symbol table keys a top-level definition by its short name —
  `DefaultSymbolIdComposer.compose` returns `localName` when the prefix is empty
  (`kernel/symbol-id.ts:22`) — and every Python strategy that consumes a bound
  type already calls `lastSegment` before looking it up
  (`python-local-binding.ts:78`). The monolith emits the dotted form and wins
  the merge where both write; the pass does not try to correct that here.
- **Naming.** Exported symbols carry domain context and are unambiguous in an
  import line (`.claude/rules/naming.md`): `pythonTypeRefFromNode`, not
  `fromNode`; `pythonAnnotationTypeSource`, not `annotationSource`. The exact
  names are fixed in Task 1 and Task 2 and MUST be identical everywhere later
  tasks use them.
- **`passes.ts` and `passes/` coexist deliberately.**
  `python/walker/passes.ts` stays the registration list;
  `python/walker/passes/` holds the passes it lists. NodeNext resolves
  `./passes.js` and `./passes/annotation-type-facts.js` unambiguously. Do not
  "fix" this by collapsing one into the other.
- **Commit format.** One commit per task,
  `<type>(language): <subject> (9fgdi)`, header ≤ 100 chars, body lines ≤ 100
  cols, `Co-Authored-By` trailer (`.claude/rules/commit-rules.md`). `feat` for
  Tasks 1–4 — each adds a capability that did not exist. `test` for Task 5 if it
  lands only gates and docs; `docs` if it is only the navigator paragraph. No
  per-task beads: `9fgdi` goes in every message.
- **No `Why:` line needed.** Nothing touched is on the deep-silo list in
  `.claude/rules/silo-pairing.md`. Do not invent one.
- **Worktree per task.** A fresh Opus subagent in its own git worktree. A fresh
  worktree has no `build/`, and the chunker pool forks the COMPILED worker, so
  run `npm run build` once before the first test run — a bare build, no
  `npm link`, no reindex.
- **Tool calls ≤ 8 minutes; writes ≤ 120 lines per call.** The corpus harnesses
  in Task 5 exceed that in wall clock (netbox 155 s, polar 284 s for the oracle
  alone) — run them with `run_in_background: true` and collect.
- **Do not reindex anything.** No `npm link`, no `index-codebase`. The gates in
  Task 5 are offline harnesses over corpus checkouts; none of them writes to
  Qdrant or DuckDB.

---

## File Structure

**Created**

| File | Single responsibility |
| --- | --- |
| `src/core/domains/language/python/walker/passes/python-type-annotation.ts` | Python annotation syntax → kernel `TypeRef`, from a subtree or from text. |
| `src/core/domains/language/python/walker/passes/python-def-scope-walk.ts` | One scoped descent over `class_definition` / `function_definition`, handing each site its class chain, method name and body kind. |
| `src/core/domains/language/python/walker/passes/python-annotation-type-source.ts` | The `annotations` `InlineTypeSource` — params, returns, annotated assignments. |
| `src/core/domains/language/python/walker/passes/python-docstring-type-source.ts` | The `docstring` `InlineTypeSource` — Google `Args:`/`Returns:`, Sphinx `:type:`/`:rtype:`. |
| `src/core/domains/language/python/walker/passes/python-type-channels.ts` | A built store → the `Partial<FileExtraction>` PYTHON publishes (decision 5). |
| `src/core/domains/language/python/walker/passes/annotation-type-facts.ts` | `PYTHON_TYPE_SOURCE_ORDER`, `PYTHON_INLINE_TYPE_SOURCES`, `pythonAnnotationTypeFacetPass`. |
| `tests/core/domains/language/python/walker/passes/python-type-annotation.test.ts` | The mapping table: every form in decision 3, plus the declined list. |
| `tests/core/domains/language/python/walker/passes/python-annotation-type-source.test.ts` | Emitted facts per site shape; the identifier/attribute skip; the single-arm gate. |
| `tests/core/domains/language/python/walker/passes/python-docstring-type-source.test.ts` | Both dialects; the "annotation present ⇒ silent" gate. |
| `tests/core/domains/language/python/walker/passes/python-type-channels.test.ts` | Channel re-keying, the dropped flat map, emit-only-non-empty. |
| `tests/core/domains/language/python/walker/passes/annotation-type-facet-pass.test.ts` | The composed walker over real Python fixtures: merged channels, precedence by line, source rank. |

**Modified**

| File | Change |
| --- | --- |
| `src/core/domains/language/python/walker/passes.ts` | `PYTHON_EXTRACTION_PASSES` gains `pythonAnnotationTypeFacetPass`; docblock updated. |
| `src/core/domains/language/python/walker/walker.ts` | `localTypeTrackingEnabled` renamed to `pythonLocalTypeTrackingEnabled` and exported. Two lines. |
| `src/core/domains/language/CLAUDE.md` | One Mechanics bullet: Python's facet, its channel re-keys, the single-arm rule. |
| `src/core/domains/language/python/CLAUDE.md` | NEW navigator stub — the pass/monolith split and the two coordinate conventions. |

**Untouched, deliberately** — listed so nobody sweeps them:

- Every kernel file. See Global Constraints.
- `python/resolver/**`. This seam fills channels the chain already reads; not
  one strategy changes. `python-self-field.ts` and `python-local-binding.ts` are
  the consumers and they need no edit to see the new facts.
- The three existing Python walker test files.
- `extractTypeName` / `extractConstructorTypeName` / `isCapWordsConstructor` in
  `walker.ts`. The pass routes around them; widening them would be the re-slice
  Model A forbids.

---

## Context the implementer needs

### `TypeFact` — every field, and what Python puts in it

`src/core/domains/language/kernel/type-facts.ts`:

```ts
export interface TypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  source?: string;
  symbolScope: string[];
  methodName?: string;
  name?: string;
  classForm?: boolean;
  line?: number;
  type: TypeRef;
}
```

| Field | Python's value |
| --- | --- |
| `kind` | `"param"` for a typed parameter, `"local"` for a PEP 526 assignment inside a function body, `"ivar"` for a class attribute (class body or `self.x`), `"return"` for a return annotation. **`"attr"` is never used** — no store method reads it, so a fact filed under it is inert. |
| `source` | `"annotations"` or `"docstring"`. |
| `symbolScope` | The enclosing CLASS chain, short names, outermost first: `["Outer","Inner"]`. `[]` for a module-level def. Functions do not contribute to it. |
| `methodName` | The enclosing `def` name for `param` / `local` / `return`. Absent for `ivar`. |
| `name` | Parameter / variable / attribute name. Absent for `return`. Attribute names carry NO leading `@` — that is Ruby's ivar spelling. |
| `classForm` | `true` when the `def` carries `@classmethod` or `@staticmethod`; drives `.` vs `#` in the structured-return key. Only meaningful on `return` facts. |
| `line` | 1-based line of the enclosing `def` for `param`, of the assignment for `local` / `ivar`, absent for `return` (name-keyed). |
| `type` | The mapper's `TypeRef`. |

### What `typeFactChannels(store, chunks)` returns

`kernel/type-fact-channels.ts` — a `Partial<FileExtraction>` with at most four
keys, each present only when non-empty:

- `chunks` — one `ChunkExtraction` per chunk whose line range holds at least one
  `param` / `local` fact, carrying `symbolId` / `scope` / `startLine` /
  `endLine` copied from the chunk, `calls: []`, and `localBindings`.
- `functionReturnTypes` — `Record<methodName, typeName>`, flat. **Dropped by
  Python** (decision 5).
- `structuredReturnTypes` — `Record<"<scope::join>#<method>", TypeRef>`, `.`
  instead of `#` when `classForm`. **Re-keyed by Python.**
- `ivarTypes` — `Record<"<scope::join>", Record<name, typeName>>`. **Re-keyed to
  `classFieldTypes` by Python.**

A container ref reduces to its ELEMENT name and a union to `undefined` in the
string-valued maps (`refToName`, `type-fact-store.ts:24`); decision 4's
single-arm gate means Python never hands those maps a shape they cannot carry.

### Which channel the self-field strategy reads

`python/resolver/strategies/python-self-field.ts:34`:

```ts
const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
const typeName = ctx.classFieldTypes?.[enclosing]?.[fieldSegment];
```

`classFieldTypes`, keyed by class SHORT name, member name bare. Not `ivarTypes`.
The monolith writes the same shape at `walker.ts:201` — `out[className]` where
`className` is the `class_definition` name node's text, so a nested class is
keyed by its own short name, and two same-named nested classes in one file
collide with last-write-wins. The pass reproduces that keying exactly rather
than improving it, so the merge overlaps instead of forking.

### What the monolith already emits, and where

| Site | Monolith behaviour | Pass adds |
| --- | --- | --- |
| `def f(x: Foo)` | `localBindings.x = [{line: <typed_parameter line>, type: "Foo"}]` (`walker.ts:419`) | nothing (identifier annotation) |
| `def f(x: Optional[Foo])` | nothing — `extractTypeName` returns `null` for `subscript` | `param` fact, `TypeRef` union collapsed to `Foo` |
| `def f(x: mod.Foo)` | `type: "mod.Foo"`, dotted | nothing (attribute annotation; base wins anyway) |
| `x: Foo = …` in a body | `localBindings.x` | nothing |
| `x: list[Foo] = …` | nothing | `local` fact — declined by the single-arm gate, so still nothing. Container refs never become bindings. |
| `self.x: Foo = …` | `classFieldTypes[C].x = "Foo"` (`walker.ts:222`) | `ivar` fact, same key, merge dedupes |
| `self.x: Optional[Foo] = …` | nothing | `ivar` fact → `classFieldTypes[C].x = "Foo"` |
| `class C: x: Foo` (class body) | a LOCAL binding named `x` in C's chunk, nothing on `classFieldTypes` | `ivar` fact → `classFieldTypes[C].x = "Foo"` — the dataclass / pydantic / Django-model case |
| `def f() -> Foo` | nothing at all | `return` fact → `structuredReturnTypes` |
| `"""Args:\n    x (Foo): …"""` | nothing | `param` fact, source `docstring`, only when `x` has no annotation |

`collectLocalBindingsForChunk` is gated by `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`
(`walker.ts:53`); `collectPythonClassFieldTypes` is NOT. The pass matches that
split exactly: the env flag suppresses its `param` / `local` facts only.

### tree-sitter-python node shapes the sources read

- `function_definition` — fields `name`, `parameters`, `return_type`, `body`.
  A `@classmethod` / `@staticmethod` def is wrapped in a `decorated_definition`
  whose named children are `decorator`s plus the `function_definition`.
- `parameters` — named children are `identifier`, `default_parameter`,
  `typed_parameter` (first named child is the pattern; field `type`),
  `typed_default_parameter` (fields `name`, `type`, `value`),
  `list_splat_pattern` / `dictionary_splat_pattern` (untyped) or a
  `typed_parameter` wrapping one of those.
- `assignment` — optional `left` (first named child), optional `type` field
  (PEP 526), optional `right` field. A `type` field's own first named child is
  the annotation expression.
- Annotation expressions: `identifier`, `attribute` (`object` + `attribute`),
  `subscript` (field `value` plus one or more `subscript` children),
  `generic_type` in some grammar builds (`value` + `type_parameter`),
  `binary_operator` (fields `left`, `operator`, `right`) for PEP 604 `X | Y`,
  `string` for a forward reference, `none`, `list` for `Callable[[X], Y]`'s
  first argument.
- A docstring is the first statement of a `block`: an `expression_statement`
  whose only named child is a `string`, whose text includes the quotes.

### Harnesses

```bash
npx tsx scripts/codegraph-chain-tally.ts --corpus <abs> --lang python --json out.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <name|abs> --seed 20260908 --json out.json
```

Corpora: ugnest `~/Dev/Collaborate/ugnest`, flask
`~/Dev/OpenSource/codegraph-test/flask`, netbox / polar / httpx under
`~/Dev/Tools/tea-rags-bench/corpora/`. The oracle also accepts a manifest NAME.
Baseline numbers to diff against are in the E0 spec's
`## Appendix — E0 baseline (2026-09-08)`.

---

## Task 1: Python annotation → `TypeRef` mapper

**Files**

- Create `src/core/domains/language/python/walker/passes/python-type-annotation.ts`
- Create `tests/core/domains/language/python/walker/passes/python-type-annotation.test.ts`

**Interfaces**

Consumes: `AstNode` (`contracts/types/ast.ts`), `TypeRef`
(`contracts/types/language.ts`), and `NIL_TYPE_REF` / `typeRefUnionOf` /
`typeRefReceiverForm` from `kernel/type-ref.ts`.

Produces:

```ts
export const PYTHON_DECLINED_TYPE_NAMES: ReadonlySet<string>;
export function pythonBareTypeName(text: string): string;
export function pythonTypeRefFromNode(node: AstNode, selfClass?: string): TypeRef | undefined;
export function pythonTypeRefFromText(text: string, selfClass?: string): TypeRef | undefined;
export function pythonNominalReceiverName(ref: TypeRef): string | undefined;
```

`pythonNominalReceiverName` is decision 4's gate in one place: it returns the
class name when `typeRefReceiverForm(ref)` collapses to a single `class` /
`instance` arm, and `undefined` otherwise. Both sources call it before emitting
a `param` / `local` / `ivar` fact; neither re-implements the test.

### Steps

- [ ] Write the failing table test first. One `describe` per group, driven by a
      `[input, expected]` table over `pythonTypeRefFromText` (the text entry
      point makes the table readable; a second, smaller describe parses real
      annotations through `pythonTypeRefFromNode` to prove the two agree):

```ts
const CASES: [string, TypeRef | undefined][] = [
  ["Foo", { form: "instance", name: "Foo" }],
  ["pkg.mod.Foo", { form: "instance", name: "Foo" }],
  ["type[Foo]", { form: "class", name: "Foo" }],
  ["Type[Foo]", { form: "class", name: "Foo" }],
  ["Optional[Foo]", { form: "union", members: [{ form: "instance", name: "Foo" }, { form: "nil" }] }],
  ["Foo | None", { form: "union", members: [{ form: "instance", name: "Foo" }, { form: "nil" }] }],
  ["Foo | Bar", { form: "union", members: [{ form: "instance", name: "Foo" }, { form: "instance", name: "Bar" }] }],
  ["Union[Foo, Bar]", { form: "union", members: [{ form: "instance", name: "Foo" }, { form: "instance", name: "Bar" }] }],
  ["list[Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["List[Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["Sequence[Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["set[Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["tuple[Foo, ...]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["dict[str, Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ["Mapping[str, Foo]", { form: "container", element: { form: "instance", name: "Foo" } }],
  ['"Foo"', { form: "instance", name: "Foo" }],
  ["'pkg.Foo'", { form: "instance", name: "Foo" }],
  ['Optional["Foo"]', { form: "union", members: [{ form: "instance", name: "Foo" }, { form: "nil" }] }],
  ["ClassVar[Foo]", { form: "instance", name: "Foo" }],
  ["Annotated[Foo, Depends()]", { form: "instance", name: "Foo" }],
  ["Awaitable[Foo]", { form: "instance", name: "Foo" }],
  ["QuerySet[Foo]", { form: "instance", name: "QuerySet" }],
  ["None", { form: "nil" }],
  ["Any", undefined],
  ["object", undefined],
  ["Callable[[int], Foo]", undefined],
  ["Literal['a', 'b']", undefined],
  ["", undefined],
];
```

- [ ] Add the negative guards the table cannot express: `Self` with no
      `selfClass` is `undefined`; `Self` with `selfClass: "Svc"` is
      `{ form: "instance", name: "Svc" }`; `pythonNominalReceiverName` returns
      `"Foo"` for `Optional[Foo]` and `undefined` for `list[Foo]`,
      `Foo | Bar` and `None`.
- [ ] Run them, watch them fail on the missing module.

- [ ] Write `python-type-annotation.ts`. The text parser is the primitive; the
      node walker delegates to it only for a quoted forward reference, so both
      entry points share one rule table:

```ts
/**
 * Python type annotations → the kernel `TypeRef` algebra (E2 seam 2, bd
 * tea-rags-mcp-9fgdi).
 *
 * Two entry points over one rule table. `pythonTypeRefFromNode` walks an
 * annotation SUBTREE — that is the hot path, once per annotated parameter, and
 * it never touches the file's source text. `pythonTypeRefFromText` parses an
 * annotation STRING, which is what a `"Foo"` forward reference and every
 * docstring type actually is; it is a bounded recursive descent over one
 * annotation, not a scan of the file.
 *
 * The forms and their answers are the seam's decision 3. Three of them earn a
 * comment:
 *
 *   - `dict[K, V]` → `container(V)`. Subscripting a dict yields the VALUE, and
 *     the value is what a `d[k].method()` receiver is; keys are almost always
 *     `str` / `int` and name no in-project class. Every other mapping type
 *     follows the same last-argument rule.
 *   - A dotted annotation reduces to its LAST segment. The symbol table keys a
 *     top-level definition by its short name (`kernel/symbol-id.ts:22`), and
 *     every Python strategy already calls `lastSegment` before looking a bound
 *     type up (`python-local-binding.ts:78`).
 *   - An unknown generic base keeps the BASE as the receiver — `QuerySet[Foo]`
 *     is a `QuerySet`, and that is the honest reading of the annotation.
 *     Unwrapping a framework wrapper (SQLAlchemy `Mapped[Foo]`) is E3's job,
 *     driven by manifest-gated data rather than by a guess here.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import { NIL_TYPE_REF, typeRefReceiverForm, typeRefUnionOf } from "../../../kernel/type-ref.js";

/** Names that carry no receiver: annotated with one of these, a site gets no fact. */
export const PYTHON_DECLINED_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Any", "AnyStr", "object", "NoReturn", "Never", "TypeVar", "Ellipsis", "Hashable",
  // Bare, un-subscripted forms of the constructors handled structurally below.
  "Optional", "Union", "Type", "Literal", "Callable", "Annotated", "ClassVar", "Final",
]);
/** Subscripted forms whose argument IS the answer — the wrapper is transparent. */
const PYTHON_TRANSPARENT_FIRST: ReadonlySet<string> = new Set([
  "ClassVar", "Final", "Annotated", "Awaitable", "Required", "NotRequired", "InitVar",
]);
/** `Coroutine[Send, Yield, Return]` — the LAST argument is the awaited value. */
const PYTHON_TRANSPARENT_LAST: ReadonlySet<string> = new Set(["Coroutine"]);
/** Element type is the FIRST argument. */
const PYTHON_CONTAINER_FIRST: ReadonlySet<string> = new Set([
  "list", "List", "set", "Set", "frozenset", "FrozenSet", "tuple", "Tuple", "deque", "Deque",
  "Sequence", "MutableSequence", "Iterable", "Iterator", "Generator", "AsyncIterable",
  "AsyncIterator", "AsyncGenerator", "Collection",
]);
/** Element type is the LAST argument — the mapping VALUE. */
const PYTHON_CONTAINER_LAST: ReadonlySet<string> = new Set([
  "dict", "Dict", "Mapping", "MutableMapping", "OrderedDict", "defaultdict", "DefaultDict", "Counter",
]);
/** Subscripted forms that name no receiver at all. */
const PYTHON_OPAQUE_GENERICS: ReadonlySet<string> = new Set(["Callable", "Literal"]);

function isTypeRef(ref: TypeRef | undefined): ref is TypeRef {
  return ref !== undefined;
}

/** `pkg.mod.Foo` → `Foo`; `Foo` → `Foo`; `""` → `""`. */
export function pythonBareTypeName(text: string): string {
  const trimmed = text.trim();
  return trimmed.slice(trimmed.lastIndexOf(".") + 1);
}

function nominalTypeRef(text: string, selfClass: string | undefined): TypeRef | undefined {
  const bare = pythonBareTypeName(text);
  if (bare.length === 0) return undefined;
  // `None` is an ARM, never an absence — `Foo | None` must stay distinguishable
  // from `Foo` all the way to the consumer (`contracts/types/language.ts:660`).
  if (bare === "None" || bare === "NoneType") return NIL_TYPE_REF;
  if (bare === "Self") return selfClass === undefined ? undefined : { form: "instance", name: selfClass };
  if (PYTHON_DECLINED_TYPE_NAMES.has(bare)) return undefined;
  return { form: "instance", name: bare };
}

/** The one subscript rule table, shared by both entry points. */
function subscriptTypeRef(baseText: string, args: (TypeRef | undefined)[], selfClass: string | undefined): TypeRef | undefined {
  const base = pythonBareTypeName(baseText);
  const first = args[0];
  const last = args[args.length - 1];
  if (base === "Optional") return first === undefined ? undefined : typeRefUnionOf([first, NIL_TYPE_REF]);
  if (base === "Union") {
    const members = args.filter(isTypeRef);
    return members.length === 0 ? undefined : typeRefUnionOf(members);
  }
  if (base === "Type" || base === "type") {
    return first !== undefined && first.form === "instance" ? { form: "class", name: first.name } : undefined;
  }
  if (PYTHON_OPAQUE_GENERICS.has(base)) return undefined;
  if (PYTHON_TRANSPARENT_FIRST.has(base)) return first;
  if (PYTHON_TRANSPARENT_LAST.has(base)) return last;
  if (PYTHON_CONTAINER_FIRST.has(base)) return first === undefined ? undefined : { form: "container", element: first };
  if (PYTHON_CONTAINER_LAST.has(base)) return last === undefined ? undefined : { form: "container", element: last };
  // Unknown generic — the base class is the receiver.
  return nominalTypeRef(base, selfClass);
}
```

- [ ] Add the two entry points and the receiver gate to the same file:

```ts
/** Split on `separator` at bracket depth 0, outside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Parse ONE annotation written as text: a forward reference, a docstring type,
 * or a test's table row. Bounded recursive descent over that string — never a
 * scan of the file.
 */
export function pythonTypeRefFromText(text: string, selfClass?: string): TypeRef | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : null;
  // Strip only a WHOLE-string literal. `"A" | "B"` also starts and ends with a
  // quote, and stripping there would corrupt both arms — so require that the
  // opening quote's partner is the final character.
  if (quote !== null && trimmed.length >= 2 && trimmed.indexOf(quote, 1) === trimmed.length - 1) {
    return pythonTypeRefFromText(trimmed.slice(1, -1), selfClass);
  }
  const arms = splitTopLevel(trimmed, "|");
  if (arms.length > 1) {
    const members = arms.map((arm) => pythonTypeRefFromText(arm, selfClass)).filter(isTypeRef);
    return members.length === 0 ? undefined : typeRefUnionOf(members);
  }
  const open = trimmed.indexOf("[");
  if (open > 0 && trimmed.endsWith("]")) {
    const args = splitTopLevel(trimmed.slice(open + 1, -1), ",").map((arg) => pythonTypeRefFromText(arg, selfClass));
    return subscriptTypeRef(trimmed.slice(0, open), args, selfClass);
  }
  return nominalTypeRef(trimmed, selfClass);
}

/**
 * Parse an annotation SUBTREE. `selfClass` is the enclosing class's short name,
 * supplied so `Self` resolves; undefined at module level, where `Self` is not
 * legal anyway.
 */
export function pythonTypeRefFromNode(node: AstNode, selfClass?: string): TypeRef | undefined {
  switch (node.type) {
    case "type":
    case "type_parameter": {
      const inner = node.namedChild(0);
      return inner === null ? undefined : pythonTypeRefFromNode(inner, selfClass);
    }
    case "identifier":
    case "dotted_name":
    case "attribute":
      return nominalTypeRef(node.text, selfClass);
    case "none":
      return NIL_TYPE_REF;
    // A forward reference is an annotation that happens to be spelled as a
    // string literal; `node.text` keeps its quotes and the text parser strips them.
    case "string":
      return pythonTypeRefFromText(node.text, selfClass);
    case "binary_operator": {
      if (node.childForFieldName("operator")?.text !== "|") return undefined;
      const members = [node.childForFieldName("left"), node.childForFieldName("right")]
        .map((side) => (side === null ? undefined : pythonTypeRefFromNode(side, selfClass)))
        .filter(isTypeRef);
      return members.length === 0 ? undefined : typeRefUnionOf(members);
    }
    case "subscript":
    case "generic_type": {
      const value = node.childForFieldName("value") ?? node.namedChild(0);
      if (value === null) return undefined;
      // `childForFieldName` yields the FIRST match only, and a subscript carries
      // one `subscript` field per argument — so read the arguments positionally.
      const rest = node.namedChildren.slice(1);
      const argNodes = rest.length === 1 && rest[0].type === "type_parameter" ? [...rest[0].namedChildren] : rest;
      return subscriptTypeRef(
        value.text,
        argNodes.map((arg) => pythonTypeRefFromNode(arg, selfClass)),
        selfClass,
      );
    }
    default:
      return undefined;
  }
}

/**
 * Decision 4's gate in ONE place: the class name when this ref has exactly one
 * reachable arm, `undefined` otherwise. A `param` / `local` / `ivar` fact is
 * emitted only when this answers — `LocalBinding.type` and `classFieldTypes`
 * are bare strings, and a container flattens to its element while a two-arm
 * union flattens to its first member, both of which name a receiver the call
 * site does not have.
 *
 * The GATE is not the VALUE: `param` / `local` facts keep the original ref so
 * `LocalBinding.typeRef` still carries the union for the dispatch engine.
 */
export function pythonNominalReceiverName(ref: TypeRef): string | undefined {
  const receiver = typeRefReceiverForm(ref);
  if (receiver === undefined) return undefined;
  return receiver.form === "class" || receiver.form === "instance" ? receiver.name : undefined;
}
```

- [ ] Run the table test — green. Run `npm run type-check` and
      `npx eslint --max-warnings 0` on the new file.
- [ ] Commit: `feat(language): map Python type annotations to kernel TypeRef (9fgdi)`.

---

## Task 2: the `annotations` inline type source

**Files**

- Create `src/core/domains/language/python/walker/passes/python-def-scope-walk.ts`
- Create `src/core/domains/language/python/walker/passes/python-annotation-type-source.ts`
- Create `tests/core/domains/language/python/walker/passes/python-annotation-type-source.test.ts`
- Modify `src/core/domains/language/python/walker/walker.ts` (rename + export the env gate)

**Interfaces**

Consumes: `pythonTypeRefFromNode` / `pythonNominalReceiverName` /
`pythonBareTypeName` (Task 1), `TypeFact` and `InlineTypeSource<TInput>`
(`kernel/type-facts.ts`).

Produces:

```ts
// python-def-scope-walk.ts
export interface PythonDefSite {
  readonly node: AstNode;                    // the `function_definition`, decorators unwrapped
  readonly decorators: readonly string[];    // bare last segments: "classmethod", "property"
  readonly classChain: readonly string[];    // enclosing classes, short names, outermost first
  readonly name: string;
  readonly line: number;                     // 1-based line of the `def`
}
export interface PythonAnnotatedAssignmentSite {
  readonly node: AstNode;                    // the `assignment` node, `type` field present
  readonly classChain: readonly string[];
  readonly methodName: string | undefined;   // undefined at class-body / module level
  readonly line: number;
}
export interface PythonScopeVisitor {
  onDef?: (site: PythonDefSite) => void;
  onAnnotatedAssignment?: (site: PythonAnnotatedAssignmentSite) => void;
}
export function walkPythonScopes(root: AstNode, visitor: PythonScopeVisitor): void;
export function pythonAnnotationExpression(typeField: AstNode): AstNode;
export function isPythonClassFormDef(decorators: readonly string[]): boolean;

// python-annotation-type-source.ts
export interface PythonTypeSourceInput {
  readonly root: AstNode;
  /** `CODEGRAPH_PY_LOCAL_TYPE_TRACKING`, read once by the pass. Gates `param` / `local` only. */
  readonly trackLocalTypes: boolean;
}
export const PYTHON_ANNOTATION_SOURCE = "annotations";
export const pythonAnnotationTypeSource: InlineTypeSource<PythonTypeSourceInput>;
```

### Steps

- [ ] Rename `localTypeTrackingEnabled` to `pythonLocalTypeTrackingEnabled` in
      `walker/walker.ts`, add `export`, update the one call site at
      `extractFromPythonFile`. Nothing else in that file moves. Existing walker
      tests must stay green with no edit.
- [ ] Write the failing source test. Parse real Python with the project's
      tree-sitter engine (follow the setup in
      `tests/core/domains/language/python/walker/python-walker.test.ts`), then
      assert the fact list. Cases, each with its negative guard:

| Fixture | Expected |
| --- | --- |
| `def f(x: Foo): ...` | NO fact — the monolith already binds it |
| `def f(x: mod.Foo): ...` | NO fact — attribute annotation, same reason |
| `def f(x: Optional[Foo]): ...` | one `param` fact, `line` = the `def` line, `type` the union |
| `def f(x: list[Foo]): ...` | NO fact — container declined by the single-arm gate |
| `def f(x: Foo \| Bar): ...` | NO fact — two reachable arms |
| `def f(x: "Foo"): ...` | one `param` fact, `type` `instance(Foo)` |
| `def f() -> Optional[Foo]: ...` | one `return` fact, no `line`, no `classForm` |
| `def f() -> None: ...` | NO fact — a nil-only ref states no receiver |
| `@classmethod\ndef make(cls) -> Foo:` inside `class C` | `return` fact with `classForm: true`, `symbolScope: ["C"]` |
| `class C:\n    svc: Optional[Svc]` | one `ivar` fact, `name: "svc"`, `type` collapsed to `instance(Svc)` |
| `class C:\n    def __init__(self):\n        self.svc: Optional[Svc] = None` | one `ivar` fact, `symbolScope: ["C"]`, no `methodName` |
| `class Outer:\n    class Inner:\n        x: Foo` | `ivar` fact with `symbolScope: ["Outer","Inner"]` |
| `def f():\n    x: Optional[Foo] = g()` | one `local` fact at the assignment line |
| the same with `trackLocalTypes: false` | `param` and `local` facts absent, `ivar` and `return` still emitted |
| `x: Foo` at module level | NO fact — no channel reads it |

- [ ] Run them; they fail on the missing modules.

- [ ] Write `python-def-scope-walk.ts`. One descent, two visitor hooks — both
      sources need identical coordinates, and two walks would be two chances to
      disagree about a line:

```ts
/**
 * The scoped descent both Python type sources share (E2 seam 2, bd
 * tea-rags-mcp-9fgdi).
 *
 * A `TypeFact` coordinate is (class chain, method name, name, line), and the
 * monolith's flat `walk(root, cb)` supplies none of the first three. This walks
 * the tree once carrying a class chain and a function stack, and hands each
 * `def` and each annotated assignment the scope it actually sits in. Both
 * sources call it, which is what guarantees the `annotations` and `docstring`
 * facts for one parameter land on the SAME coordinate — `coordinateKey`
 * includes `line` (`kernel/type-fact-store.ts:80`), so a disagreement there
 * would keep both facts instead of letting the ranked one win.
 *
 * Classes contribute to the chain; functions do not. A nested `def` therefore
 * reports its parent's class chain and its own name, which matches what
 * `pyNameOf` + the chunker compose for that node.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBareTypeName } from "./python-type-annotation.js";

/** `@classmethod` / `@staticmethod` mark a def whose structured-return key joins with `.`. */
export function isPythonClassFormDef(decorators: readonly string[]): boolean {
  return decorators.includes("classmethod") || decorators.includes("staticmethod");
}

/** Unwrap tree-sitter-python's `type` wrapper to the annotation expression itself. */
export function pythonAnnotationExpression(typeField: AstNode): AstNode {
  return typeField.type === "type" ? (typeField.namedChild(0) ?? typeField) : typeField;
}

function decoratorNames(decorated: AstNode): string[] {
  const out: string[] = [];
  for (const child of decorated.namedChildren) {
    if (child.type !== "decorator") continue;
    const expr = child.namedChild(0);
    if (expr === null) continue;
    // `@app.route("/x")` — the decorator's identity is the CALLEE, not the call.
    const target = expr.type === "call" ? expr.childForFieldName("function") : expr;
    if (target !== null) out.push(pythonBareTypeName(target.text));
  }
  return out;
}

export function walkPythonScopes(root: AstNode, visitor: PythonScopeVisitor): void {
  const classChain: string[] = [];
  const fnStack: string[] = [];

  const descendBody = (node: AstNode): void => {
    const body = node.childForFieldName("body");
    if (body === null) return;
    for (const child of body.namedChildren) descend(child);
  };

  const visitDefinition = (node: AstNode, decorators: readonly string[]): void => {
    const name = node.childForFieldName("name")?.text;
    if (name === undefined) return;
    if (node.type === "class_definition") {
      classChain.push(name);
      descendBody(node);
      classChain.pop();
      return;
    }
    visitor.onDef?.({ node, decorators, name, classChain: [...classChain], line: node.startPosition.row + 1 });
    fnStack.push(name);
    descendBody(node);
    fnStack.pop();
  };

  const descend = (node: AstNode): void => {
    if (node.type === "decorated_definition") {
      const inner = node.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition");
      if (inner !== undefined) visitDefinition(inner, decoratorNames(node));
      return;
    }
    if (node.type === "function_definition" || node.type === "class_definition") {
      visitDefinition(node, []);
      return;
    }
    if (node.type === "assignment" && node.childForFieldName("type") !== null) {
      visitor.onAnnotatedAssignment?.({
        node,
        classChain: [...classChain],
        methodName: fnStack[fnStack.length - 1],
        line: node.startPosition.row + 1,
      });
      return;
    }
    for (const child of node.namedChildren) descend(child);
  };

  for (const child of root.namedChildren) descend(child);
}
```

  The three interfaces from **Interfaces** above (`PythonDefSite`,
  `PythonAnnotatedAssignmentSite`, `PythonScopeVisitor`) are declared verbatim
  at the top of this file, above `isPythonClassFormDef`.

- [ ] Write `python-annotation-type-source.ts`:

```ts
/**
 * The `annotations` type source: PEP 484 / 526 / 604 annotations → `TypeFact`s
 * (E2 seam 2, bd tea-rags-mcp-9fgdi). The largest recall lever in the E0
 * baseline — `annotationReturn` carries 2,955 of the 4,509 losses.
 *
 * It emits only what the native walker declines. `extractTypeName`
 * (`walker/walker.ts:447`) answers for a bare `identifier` and a dotted
 * `attribute` and returns `null` for everything else, so the walker already
 * binds `x: Foo` and `x: mod.Foo` and drops `Optional[Foo]`, `list[Foo]`,
 * `Foo | Bar` and `"Foo"`. Re-emitting the two shapes it handles would only
 * duplicate a binding — `mergeLocalBindings` concatenates, it does not dedupe
 * (`kernel/merge-extraction.ts:70`) — so those two node types are skipped.
 * `ivar` and `return` facts have no such gate: their channels union by key.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import {
  isPythonClassFormDef,
  pythonAnnotationExpression,
  walkPythonScopes,
} from "./python-def-scope-walk.js";
import { pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

export const PYTHON_ANNOTATION_SOURCE = "annotations";

export interface PythonTypeSourceInput {
  readonly root: AstNode;
  readonly trackLocalTypes: boolean;
}

interface PythonTypedParam {
  readonly name: string;
  readonly annotation: AstNode;
}

function typedParameters(fn: AstNode): PythonTypedParam[] {
  const params = fn.childForFieldName("parameters");
  if (params === null) return [];
  const out: PythonTypedParam[] = [];
  for (const param of params.namedChildren) {
    if (param.type !== "typed_parameter" && param.type !== "typed_default_parameter") continue;
    const typeField = param.childForFieldName("type");
    if (typeField === null) continue;
    // `typed_default_parameter` names the identifier; `typed_parameter` puts the
    // pattern first. A `*args: int` / `**kw: Any` pattern is not an identifier
    // and is skipped — a splat binds a tuple / dict, never the annotated type.
    const nameNode = param.childForFieldName("name") ?? param.namedChild(0);
    if (nameNode === null || nameNode.type !== "identifier") continue;
    out.push({ name: nameNode.text, annotation: pythonAnnotationExpression(typeField) });
  }
  return out;
}

/** The walker already binds these two shapes; only what it declines is new. */
function walkerAlreadyBinds(annotation: AstNode): boolean {
  return annotation.type === "identifier" || annotation.type === "attribute";
}

function extractPythonAnnotationFacts(input: PythonTypeSourceInput): TypeFact[] {
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const selfClass = site.classChain[site.classChain.length - 1];
      if (input.trackLocalTypes) {
        for (const param of typedParameters(site.node)) {
          if (walkerAlreadyBinds(param.annotation)) continue;
          const ref = pythonTypeRefFromNode(param.annotation, selfClass);
          if (ref === undefined || pythonNominalReceiverName(ref) === undefined) continue;
          facts.push({
            kind: "param",
            source: PYTHON_ANNOTATION_SOURCE,
            symbolScope: [...site.classChain],
            methodName: site.name,
            name: param.name,
            // The `def` line, ALWAYS — a signature spanning lines must not put
            // one parameter's binding below another's, and the docstring source
            // has to be able to collide with this coordinate.
            line: site.line,
            type: ref,
          });
        }
      }
      const returnType = site.node.childForFieldName("return_type");
      if (returnType === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(returnType), selfClass);
      // A nil-only ref states "no receiver" and no consumer reads that yet;
      // emitting it would put a `-> None` entry on every annotated def.
      if (ref === undefined || ref.form === "nil") return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_ANNOTATION_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: ref,
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
    onAnnotatedAssignment: (site) => pushAssignmentFact(facts, site, input.trackLocalTypes),
  });
  return facts;
}

export const pythonAnnotationTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_ANNOTATION_SOURCE,
  extract: extractPythonAnnotationFacts,
};
```

- [ ] Add `pushAssignmentFact` to the same file — the three annotated-assignment
      shapes, each landing on a different channel:

```ts
/**
 * `x: T` inside a function is a LOCAL; `self.x: T` and a class-body `x: T` are
 * both class ATTRIBUTES. The last one is the case the walker cannot see at all:
 * `collectPythonClassFieldTypes` requires an `attribute` LHS whose object is
 * `self` (`walker/walker.ts:215`), so a dataclass / pydantic / Django field
 * declared in the class body reaches `classFieldTypes` only through here.
 *
 * An attribute fact stores the COLLAPSED nominal ref, not the original.
 * `ivarTypesMap` reduces its value with `refToName`, which answers `undefined`
 * for a union and drops the entry silently (`kernel/type-fact-store.ts:24`), and
 * `classFieldTypes` is a bare string map with nowhere to carry the arms anyway.
 * A local / param fact keeps the original, because `LocalBinding.typeRef` does
 * carry them.
 */
function pushAssignmentFact(
  facts: TypeFact[],
  site: PythonAnnotatedAssignmentSite,
  trackLocalTypes: boolean,
): void {
  const typeField = site.node.childForFieldName("type");
  if (typeField === null) return;
  const annotation = pythonAnnotationExpression(typeField);
  const selfClass = site.classChain[site.classChain.length - 1];
  const ref = pythonTypeRefFromNode(annotation, selfClass);
  if (ref === undefined) return;
  const nominal = pythonNominalReceiverName(ref);
  if (nominal === undefined) return;
  const attributeFact = (name: string): TypeFact => ({
    kind: "ivar",
    source: PYTHON_ANNOTATION_SOURCE,
    symbolScope: [...site.classChain],
    name,
    line: site.line,
    type: { form: "instance", name: nominal },
  });

  const lhs = site.node.namedChild(0);
  if (lhs === null) return;

  if (lhs.type === "attribute") {
    const object = lhs.childForFieldName("object");
    const attribute = lhs.childForFieldName("attribute");
    if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return;
    if (site.classChain.length === 0) return;
    facts.push(attributeFact(attribute.text));
    return;
  }
  if (lhs.type !== "identifier") return;

  if (site.methodName === undefined) {
    // Class body — a declared attribute. Module level has no channel that reads it.
    if (site.classChain.length > 0) facts.push(attributeFact(lhs.text));
    return;
  }
  if (!trackLocalTypes || walkerAlreadyBinds(annotation)) return;
  facts.push({
    kind: "local",
    source: PYTHON_ANNOTATION_SOURCE,
    symbolScope: [...site.classChain],
    methodName: site.methodName,
    name: lhs.text,
    line: site.line,
    type: ref,
  });
}
```

- [ ] Import `PythonAnnotatedAssignmentSite` as a type alongside the two
      functions already imported from `python-def-scope-walk.js`.
- [ ] Run the source test — green. Run the three existing Python walker tests
      and confirm `git diff --stat -- tests/core/domains/language/python` lists
      only the new file.
- [ ] `npm run type-check`, `npx eslint --max-warnings 0` on the two new files.
- [ ] Commit: `feat(language): read Python annotations as ranked type facts (9fgdi)`.

---

## Task 3: the `docstring` inline type source

**Files**

- Create `src/core/domains/language/python/walker/passes/python-docstring-type-source.ts`
- Create `tests/core/domains/language/python/walker/passes/python-docstring-type-source.test.ts`

**Interfaces**

Consumes: `walkPythonScopes` / `isPythonClassFormDef` (Task 2),
`pythonTypeRefFromText` / `pythonNominalReceiverName` (Task 1),
`PythonTypeSourceInput` (Task 2).

Produces:

```ts
export const PYTHON_DOCSTRING_SOURCE = "docstring";
export const pythonDocstringTypeSource: InlineTypeSource<PythonTypeSourceInput>;
```

**Scope.** Two dialects, because two are what the corpora carry (ugnest Google
×252, flask Sphinx ×230):

- Google — a `Args:` section whose entries read `name (Type): description`, and
  a `Returns:` section whose first line reads `Type: description`.
- Sphinx — `:type name: Type` and `:rtype: Type`.

Anything else (numpydoc, epytext, `:param Type name:`) is out of scope and
files no fact. A docstring type is text, so it goes through
`pythonTypeRefFromText`, which means `Optional[Foo]`, `List[Foo]` and
`Foo | None` all read the same as in an annotation.

**The disjointness gate.** A param fact is emitted ONLY for a parameter with no
annotation node, and a return fact ONLY when the def has no `return_type`. So
the docstring source can never collide with the annotations source in
production, and the whole docstring is skipped when a def has neither an
un-annotated parameter nor a missing return type — which on polar and httpx is
almost every def.

### Steps

- [ ] Write the failing test first. Fixtures, with negative guards:

| Fixture | Expected |
| --- | --- |
| Google `Args:\n    req (Request): the request` on `def f(req):` | one `param` fact, `line` = the `def` line, source `docstring` |
| the same on `def f(req: Request):` | NO fact — the parameter is annotated |
| Google `Returns:\n    Session: the session` on `def f():` | one `return` fact |
| the same on `def f() -> Session:` | NO fact — the def has a return annotation |
| Google `Returns:\n    The open session, if any.` | NO fact — not a type token |
| Sphinx `:type req: Request` / `:rtype: Session` | one `param` + one `return` fact |
| Google `Args:\n    xs (list[Foo]): …` | NO fact — container declined by the single-arm gate |
| Google `Args:\n    self (Foo): …` | NO fact — `self` / `cls` never bind |
| a def with no docstring | no facts, and `docstringText` returns `undefined` |
| numpydoc `Parameters\n----------\nreq : Request` | NO fact — out of scope |

- [ ] Write `python-docstring-type-source.ts`:

```ts
/**
 * The `docstring` type source: Google `Args:` / `Returns:` and Sphinx
 * `:type:` / `:rtype:` (E2 seam 2, bd tea-rags-mcp-9fgdi). Two dialects,
 * because two are what the corpora carry — ugnest documents 252 defs in Google
 * style, flask 230 in Sphinx. numpydoc and epytext file nothing.
 *
 * Ranked BELOW `annotations` in `PYTHON_TYPE_SOURCE_ORDER`, and disjoint from it
 * by construction: a param fact needs a parameter with no annotation node, a
 * return fact needs a def with no `return_type`. A def that satisfies neither
 * never has its docstring read at all, which is what keeps this off the hot
 * path on the annotated corpora.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import { isPythonClassFormDef, walkPythonScopes } from "./python-def-scope-walk.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { pythonNominalReceiverName, pythonTypeRefFromText } from "./python-type-annotation.js";

export const PYTHON_DOCSTRING_SOURCE = "docstring";

const GOOGLE_ARGS_HEADER = /^\s*(?:Args|Arguments|Parameters)\s*:\s*$/;
const GOOGLE_RETURNS_HEADER = /^\s*(?:Returns|Yields)\s*:\s*$/;
const GOOGLE_ANY_HEADER = /^\s*[A-Z][A-Za-z ]*:\s*$/;
const GOOGLE_ARG_ENTRY = /^\s*(\*{0,2}[A-Za-z_]\w*)\s*\(([^)]+)\)\s*:/;
const GOOGLE_RETURN_ENTRY = /^\s*([^:]+?)\s*:/;
const SPHINX_TYPE = /^\s*:type\s+(\*{0,2}[A-Za-z_]\w*)\s*:\s*(.+?)\s*$/;
const SPHINX_RTYPE = /^\s*:rtype\s*:\s*(.+?)\s*$/;

/**
 * A type token, not prose. Bracketed groups are removed first, then what is left
 * must be dotted names joined by `|` — so `Optional[Foo]`, `dict[str, Foo]` and
 * `Foo | None` pass while `The open session, if any` does not.
 */
function isDocstringTypeToken(text: string): boolean {
  const outsideBrackets = text.replace(/\[[^\]]*\]/g, "").trim();
  return /^[\w.]+(?:\s*\|\s*[\w.]+)*$/.test(outsideBrackets);
}

function acceptedType(text: string): string | undefined {
  const trimmed = text.trim();
  return isDocstringTypeToken(trimmed) ? trimmed : undefined;
}

/** The docstring body with its quotes and any prefix removed; `undefined` when there is none. */
export function pythonDocstringText(fn: AstNode): string | undefined {
  const first = fn.childForFieldName("body")?.namedChild(0);
  if (first === null || first === undefined) return undefined;
  const literal = first.type === "string" ? first : first.type === "expression_statement" ? first.namedChild(0) : null;
  if (literal === null || literal.type !== "string") return undefined;
  const raw = literal.text;
  const quoteAt = raw.search(/["']/);
  if (quoteAt === -1) return undefined;
  const body = raw.slice(quoteAt);
  for (const quote of ['"""', "'''", '"', "'"]) {
    if (!body.startsWith(quote)) continue;
    const inner = body.slice(quote.length);
    return inner.endsWith(quote) ? inner.slice(0, -quote.length) : inner;
  }
  return body;
}
```

- [ ] Add the parser and the source to the same file:

```ts
interface DocstringTypes {
  readonly params: Map<string, string>;
  readonly returnType: string | undefined;
}

function parseDocstringTypes(doc: string): DocstringTypes {
  const params = new Map<string, string>();
  let returnType: string | undefined;
  let section: "args" | "returns" | null = null;
  const addParam = (name: string, text: string): void => {
    if (name.startsWith("*")) return; // a splat binds a tuple / dict, not the type
    const accepted = acceptedType(text);
    if (accepted !== undefined && !params.has(name)) params.set(name, accepted);
  };
  for (const line of doc.split(/\r?\n/)) {
    const sphinxParam = SPHINX_TYPE.exec(line);
    if (sphinxParam !== null) {
      addParam(sphinxParam[1], sphinxParam[2]);
      continue;
    }
    const sphinxReturn = SPHINX_RTYPE.exec(line);
    if (sphinxReturn !== null) {
      returnType ??= acceptedType(sphinxReturn[1]);
      continue;
    }
    if (GOOGLE_ARGS_HEADER.test(line)) {
      section = "args";
      continue;
    }
    if (GOOGLE_RETURNS_HEADER.test(line)) {
      section = "returns";
      continue;
    }
    if (GOOGLE_ANY_HEADER.test(line)) {
      section = null;
      continue;
    }
    if (section === "args") {
      const entry = GOOGLE_ARG_ENTRY.exec(line);
      if (entry !== null) addParam(entry[1], entry[2]);
      continue;
    }
    if (section === "returns") {
      const entry = GOOGLE_RETURN_ENTRY.exec(line);
      // The FIRST non-blank line of `Returns:` carries the type; the rest is prose.
      if (entry !== null) {
        returnType ??= acceptedType(entry[1]);
        section = null;
      } else if (line.trim().length > 0) {
        section = null;
      }
    }
  }
  return { params, returnType };
}

/** Parameter names the signature leaves untyped — `self` / `cls` never bind. */
function unannotatedParameterNames(fn: AstNode): Set<string> {
  const out = new Set<string>();
  const params = fn.childForFieldName("parameters");
  if (params === null) return out;
  for (const param of params.namedChildren) {
    if (param.type === "identifier") out.add(param.text);
    else if (param.type === "default_parameter") {
      const name = param.childForFieldName("name");
      if (name !== null && name.type === "identifier") out.add(name.text);
    }
  }
  out.delete("self");
  out.delete("cls");
  return out;
}

function extractPythonDocstringFacts(input: PythonTypeSourceInput): TypeFact[] {
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      const needsReturn = site.node.childForFieldName("return_type") === null;
      const openParams = input.trackLocalTypes ? unannotatedParameterNames(site.node) : new Set<string>();
      if (!needsReturn && openParams.size === 0) return;
      const doc = pythonDocstringText(site.node);
      if (doc === undefined) return;
      const parsed = parseDocstringTypes(doc);
      const selfClass = site.classChain[site.classChain.length - 1];
      for (const [name, text] of parsed.params) {
        if (!openParams.has(name)) continue;
        const ref = pythonTypeRefFromText(text, selfClass);
        if (ref === undefined || pythonNominalReceiverName(ref) === undefined) continue;
        facts.push({
          kind: "param",
          source: PYTHON_DOCSTRING_SOURCE,
          symbolScope: [...site.classChain],
          methodName: site.name,
          name,
          line: site.line,
          type: ref,
        });
      }
      if (!needsReturn || parsed.returnType === undefined) return;
      const ref = pythonTypeRefFromText(parsed.returnType, selfClass);
      if (ref === undefined || ref.form === "nil") return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_DOCSTRING_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: ref,
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
  });
  return facts;
}

export const pythonDocstringTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_DOCSTRING_SOURCE,
  extract: extractPythonDocstringFacts,
};
```

- [ ] Run the docstring test — green. `npm run type-check`,
      `npx eslint --max-warnings 0`.
- [ ] Commit: `feat(language): read Google and Sphinx docstring types as ranked facts (9fgdi)`.

---

## Task 4: the facet pass, the channel adapter, and the registration

**Files**

- Create `src/core/domains/language/python/walker/passes/python-type-channels.ts`
- Create `src/core/domains/language/python/walker/passes/annotation-type-facts.ts`
- Create `tests/core/domains/language/python/walker/passes/python-type-channels.test.ts`
- Create `tests/core/domains/language/python/walker/passes/annotation-type-facet-pass.test.ts`
- Modify `src/core/domains/language/python/walker/passes.ts`

**Interfaces**

Consumes: `TypeFactStore` (`kernel/type-fact-store.ts`), `typeFactChannels`
(`kernel/type-fact-channels.ts`), `ExtractionFacetPass`
(`kernel/extraction-passes.ts`), both sources, and
`pythonLocalTypeTrackingEnabled` (Task 2).

Produces:

```ts
// python-type-channels.ts
export function pythonStructuredReturnKey(kernelKey: string): string;
export function pythonTypeChannels(store: TypeFactStore, chunks: WalkContext["chunks"]): Partial<FileExtraction>;

// annotation-type-facts.ts
export const PYTHON_TYPE_SOURCE_ORDER: readonly string[];
export const PYTHON_INLINE_TYPE_SOURCES: readonly InlineTypeSource<PythonTypeSourceInput>[];
export const pythonAnnotationTypeFacetPass: ExtractionFacetPass;
```

`ExtractionPass<T>` declares `run` and nothing else
(`contracts/types/language.ts:229`) — the pass object has no `name` field.

### Steps

- [ ] Write the failing channel test. Build stores from hand-written facts (no
      parsing) and assert:
      - a `return` fact with `symbolScope: []`, `methodName: "run"` →
        `structuredReturnTypes` key `"run"`.
      - `symbolScope: ["Svc"]` → `"Svc#run"`; with `classForm: true` →
        `"Svc.run"`.
      - `symbolScope: ["Outer","Inner"]` → `"Outer.Inner#run"`.
      - an `ivar` fact with `symbolScope: ["Outer","Inner"]`, `name: "svc"` →
        `classFieldTypes` `{ Inner: { svc: "Svc" } }`, no `ivarTypes` key.
      - `functionReturnTypes` is NEVER a key of the result, even when the store
        answers one.
      - an empty store → `Object.keys(out)` is `[]`.
- [ ] Write `python-type-channels.ts`:

```ts
/**
 * A built `TypeFactStore` → the `Partial<FileExtraction>` PYTHON publishes
 * (E2 seam 2, bd tea-rags-mcp-9fgdi).
 *
 * `typeFactChannels` renders a store as four channels in the shape RUBY reads.
 * Two of them are wrong for Python and one is a trap, so this wraps it:
 *
 *   - `ivarTypes` → `classFieldTypes`. `PythonSelfFieldSymbolResolutionStrategy`
 *     reads `ctx.classFieldTypes?.[enclosing]?.[field]` where `enclosing` is the
 *     class SHORT name off `callerScope` (`python-self-field.ts:34`), and no
 *     Python strategy reads `ivarTypes` at all — Python has no `@ivar` receiver.
 *   - `structuredReturnTypes` keys move from Ruby's `::` join to Python's
 *     symbolId spelling, so a key IS the callee's id as `pyNameOf` and
 *     `DefaultSymbolIdComposer` compose it (`python/kernel.ts:41` sets
 *     `scopeSeparator: "."`).
 *   - `functionReturnTypes` is DROPPED. It is keyed by bare method name and
 *     absorbed run-global with last-write-wins
 *     (`trajectory/codegraph/symbols/run-state.ts:1068`); at Python's annotation
 *     density one `def get(self) -> Foo` would speak for every `get` in the
 *     corpus (`kernel/type-fact-store.ts:30`, bd h4hxh). The owner-qualified
 *     channel says the same thing without the collision.
 *
 * Emit-only-non-empty is preserved end to end: a channel the kernel helper left
 * absent stays absent here.
 */
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { TypeRef, WalkContext } from "../../../../../contracts/types/language.js";
import { typeFactChannels } from "../../../kernel/type-fact-channels.js";
import type { TypeFactStore } from "../../../kernel/type-fact-store.js";

/**
 * `""#run` → `run`; `Svc#run` → `Svc#run`; `Outer::Inner#run` → `Outer.Inner#run`.
 * An empty scope leaves the member separator leading, and a top-level def's id is
 * its bare name (`compose` returns `localName` for an empty prefix).
 */
export function pythonStructuredReturnKey(kernelKey: string): string {
  if (kernelKey.startsWith("#") || kernelKey.startsWith(".")) return kernelKey.slice(1);
  return kernelKey.split("::").join(".");
}

export function pythonTypeChannels(store: TypeFactStore, chunks: WalkContext["chunks"]): Partial<FileExtraction> {
  const kernel = typeFactChannels(store, chunks);
  const out: Partial<FileExtraction> = {};
  if (kernel.chunks !== undefined) out.chunks = kernel.chunks;

  if (kernel.structuredReturnTypes !== undefined) {
    const rekeyed: Record<string, TypeRef> = {};
    for (const [key, ref] of Object.entries(kernel.structuredReturnTypes)) {
      rekeyed[pythonStructuredReturnKey(key)] = ref;
    }
    out.structuredReturnTypes = rekeyed;
  }

  if (kernel.ivarTypes !== undefined) {
    const classFieldTypes: Record<string, Record<string, string>> = {};
    for (const [fqClass, fields] of Object.entries(kernel.ivarTypes)) {
      const segments = fqClass.split("::");
      const shortName = segments[segments.length - 1];
      // Last write wins across same-short-named nested classes, exactly as
      // `collectPythonClassFieldTypes` merges them (`walker/walker.ts:256`).
      classFieldTypes[shortName] = { ...(classFieldTypes[shortName] ?? {}), ...fields };
    }
    out.classFieldTypes = classFieldTypes;
  }

  return out;
}
```

- [ ] Write `annotation-type-facts.ts` — the pass itself, and the two constants
      that decide Python's ranks:

```ts
/**
 * Python's type-fact facet (E2 seam 2, bd tea-rags-mcp-9fgdi) — the whole seam
 * in one `ExtractionFacetPass`:
 * `sources → TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER) → pythonTypeChannels`.
 *
 * The native walker is untouched and runs first; `mergeExtraction` folds this in
 * append-only, so a coordinate the walker already wrote keeps the walker's
 * answer. That is the whole reason a new Python facet is a new pass rather than
 * an edit to `extractFromPythonFile`.
 */
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/extraction-passes.js";
import type { InlineTypeSource } from "../../../kernel/type-facts.js";
import { TypeFactStore } from "../../../kernel/type-fact-store.js";
import { pythonLocalTypeTrackingEnabled } from "../walker.js";
import {
  PYTHON_ANNOTATION_SOURCE,
  pythonAnnotationTypeSource,
  type PythonTypeSourceInput,
} from "./python-annotation-type-source.js";
import { PYTHON_DOCSTRING_SOURCE, pythonDocstringTypeSource } from "./python-docstring-type-source.js";
import { pythonTypeChannels } from "./python-type-channels.js";

/**
 * Python's source precedence, highest first. `"ast"` is the walker's own
 * constructor inference, which still lives in the monolith — the rank is
 * declared here so the day it becomes a source there is nothing to decide.
 */
export const PYTHON_TYPE_SOURCE_ORDER: readonly string[] = [
  PYTHON_ANNOTATION_SOURCE,
  PYTHON_DOCSTRING_SOURCE,
  "ast",
];

export const PYTHON_INLINE_TYPE_SOURCES: readonly InlineTypeSource<PythonTypeSourceInput>[] = [
  pythonAnnotationTypeSource,
  pythonDocstringTypeSource,
];

export const pythonAnnotationTypeFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    // Read ONCE per file, exactly where the monolith reads it, and pass it down
    // so both sources stay pure functions of their input.
    const input: PythonTypeSourceInput = { root, trackLocalTypes: pythonLocalTypeTrackingEnabled() };
    const facts = PYTHON_INLINE_TYPE_SOURCES.flatMap((source) => source.extract(input));
    if (facts.length === 0) return {};
    return pythonTypeChannels(TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER), ctx.chunks);
  },
};
```

- [ ] Register it. `python/walker/passes.ts` becomes:

```ts
/**
 * Python's ordered extraction passes. The type-fact facet (bd
 * tea-rags-mcp-9fgdi) is the first entry; the other E2 facets Python is
 * expected to pull on (decorator expander, method signatures, re-exports)
 * arrive HERE, one `ExtractionFacetPass` each, rather than growing
 * `extractFromPythonFile`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";
import { pythonAnnotationTypeFacetPass } from "./passes/annotation-type-facts.js";

export const PYTHON_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [pythonAnnotationTypeFacetPass];
```

- [ ] Write the walker-level test — the one that proves the seam, over real
      Python parsed by the project's engine and run through `PythonLanguage`'s
      composed walker (not `extractFromPythonFile` directly, or the pass never
      runs). Fixture:

```python
from svc import Session, Repo

class Service:
    repo: Repo

    def __init__(self, session: Optional[Session]) -> None:
        self.session: Optional[Session] = session

    def run(self, target: "Repo") -> Session:
        target = Repo()
        return target.open()
```

  Assertions:

      - `classFieldTypes.Service` is `{ repo: "Repo", session: "Session" }` —
        the class-body declaration and the annotated `self.` assignment, neither
        of which the monolith reaches.
      - `structuredReturnTypes["Service#run"]` is
        `{ form: "instance", name: "Session" }`; there is NO `Service#__init__`
        key, because `-> None` files nothing.
      - `functionReturnTypes` and `ivarTypes` are absent from the extraction.
      - the `Service#run` chunk's `localBindings.target` holds BOTH bindings in
        line order: the pass's `Repo` at the `def` line, then the monolith's
        `Repo` at the reassignment — proving `mergeLocalBindings` re-sorted, and
        that a later constructor supersedes an earlier parameter annotation.
      - the `Service#__init__` chunk's `localBindings.session` carries `typeRef`
        with the `Optional[Session]` union and `type: "Session"`.
- [ ] Add the rank test the two disjoint sources cannot produce naturally: build
      one `annotations` and one `docstring` `TypeFact` at the SAME coordinate by
      hand, `TypeFactStore.fromFacts(both, PYTHON_TYPE_SOURCE_ORDER)`, assert the
      annotation's type survives — and that it survives regardless of which order
      the two facts were pushed in.
- [ ] Run the whole Python suite plus `tests/core/domains/language/kernel/`. The
      staged diff under `tests/core/domains/language/python` must list only new
      files, no modified ones.
- [ ] `npm run type-check`, `npx eslint --max-warnings 0`.
- [ ] Commit: `feat(language): publish Python annotation type facts through an extraction pass (9fgdi)`.

---

## Task 5: gates and navigators

**Files**

- Modify `src/core/domains/language/CLAUDE.md`
- Create `src/core/domains/language/python/CLAUDE.md`

No source changes. If a gate fails, fix the source in the task that owns it and
re-run — do not patch around a number here.

### Steps

- [ ] **Unit + coverage.** `npm run test:coverage`. Nothing below threshold, and
      the three pre-existing Python walker tests unmodified. A threshold failure
      goes to the `coverage-expander` subagent, never to a lowered threshold.
- [ ] **Chain tally, five corpora.** Run before the first source edit and again
      now, same machine, `--lang python`, `--json` to separate files:

```bash
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Collaborate/ugnest --lang python --json /tmp/tally-ugnest-after.json
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/OpenSource/codegraph-test/flask --lang python --json /tmp/tally-flask-after.json
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/netbox --lang python --json /tmp/tally-netbox-after.json
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/polar --lang python --json /tmp/tally-polar-after.json
npx tsx scripts/codegraph-chain-tally.ts --corpus ~/Dev/Tools/tea-rags-bench/corpora/httpx --lang python --json /tmp/tally-httpx-after.json
```

      Gate: `chainDrift` 0 on every corpus and every run completes. Edge counts
      may move in EITHER direction and neither direction is by itself a pass or
      a fail — a new nominal binding adds edges, while a binding onto a builtin
      or a stdlib type turns a short-name guess into a `DROP` at
      `python-local-binding.ts:56` and removes one. The tally is a crash-and-drift
      gate here; the oracle below is the verdict.

- [ ] **jedi oracle A/B.** BEFORE is a run at the integration HEAD `d7590b0dd`
      (the E0 appendix numbers are that HEAD, but re-run rather than quoting —
      the appendix predates this branch's other seams); AFTER is the same
      command post-Task 4. Fixed seed, one run each, background:

```bash
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus httpx --seed 20260908 --json /tmp/oracle-httpx-after.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus flask --seed 20260908 --json /tmp/oracle-flask-after.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus ugnest --seed 20260908 --json /tmp/oracle-ugnest-after.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus netbox --seed 20260908 --json /tmp/oracle-netbox-after.json
npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus polar --seed 20260908 --json /tmp/oracle-polar-after.json
```

      Gate, per the relocation protocol's step 4 and this seam's target
      categories:
      - `annotationReturn` and `annotationParam` `missed` DROP. Baseline to beat:
        2,829 and 141 respectively across the five corpora (E0 appendix,
        "Missed-shape category ranking").
      - `match` up overall.
      - `phantom` not up on any corpus. Baseline: httpx 271, flask 207,
        ugnest 655, netbox 7,968, polar 3,768.
      - `lost` 0 — no site that resolved correctly before now misses.
      - `wrongFile` not up.
      polar is the corpus that decides this seam (2,186 of the annotationReturn
      losses); netbox is the control, at 3.4% annotation coverage it should
      barely move, and a large netbox swing means something other than
      annotations changed.
- [ ] **Perf A/B.** The pass runs per file, so its cost is real. Same machine,
      interleaved before/after/before/after, report the MIN of two runs per side,
      on netbox (the largest file count) and polar (the densest annotations):
      wall clock from the tally run and peak RSS via `/usr/bin/time -l`.
      Ceiling: +25% wall, +20% RSS. Over ceiling, the first suspects are the
      docstring source (confirm the "def needs nothing" early return actually
      fires — instrument the count of docstrings parsed) and `node.text` on
      annotation subtrees.
- [ ] **Navigator paragraph** in `src/core/domains/language/CLAUDE.md`, under
      Mechanics, immediately after the existing "Type facts: kernel store,
      language-owned ranks" bullet, which it extends rather than restates:

```markdown
- **Python publishes type facts on THREE channels, not the kernel's four.**
  `python/walker/passes/annotation-type-facts.ts` is the only entry in
  `PYTHON_EXTRACTION_PASSES`: two inline sources (`annotations`, then
  `docstring`, disjoint by construction) → `TypeFactStore` under
  `PYTHON_TYPE_SOURCE_ORDER` → `pythonTypeChannels`, which wraps
  `typeFactChannels` and re-keys its output. `ivarTypes` becomes
  `classFieldTypes` keyed by class SHORT name, because that is what
  `python-self-field.ts:34` reads and Python has no `@ivar` receiver;
  `structuredReturnTypes` keys are re-spelled with `.` so a key IS the callee's
  symbolId; `functionReturnTypes` is dropped entirely. A `param` / `local` /
  `ivar` fact is emitted only when `pythonNominalReceiverName` answers — one
  reachable arm — and only for annotation shapes `extractTypeName`
  (`walker/walker.ts:447`) declines. Why: `LocalBinding.type` is a bare string
  that flattens a container to its element and a union to its first member, so
  `xs: list[Foo]` would type the LIST as a `Foo`; `mergeLocalBindings`
  concatenates rather than dedupes, so re-emitting a shape the walker already
  bound doubles the payload on every annotated def; and the bare-name
  `functionReturnTypes` map is absorbed run-global with last-write-wins, where
  at Python's annotation density one `-> Foo` would speak for every same-named
  method in the corpus.
```

- [ ] **New navigator stub** `src/core/domains/language/python/CLAUDE.md`. Local
      code-editing knowledge only; it LINKS to the parent's bullet rather than
      restating it:

```markdown
# domains/language/python — walker monolith + one type-fact pass

## Invariants

- **A new Python extraction facet is a new pass, never an edit to
  `extractFromPythonFile`.** `walker/passes.ts` lists them;
  `walker/passes/` holds them. The two paths coexist deliberately — do not
  collapse one into the other. Why: `mergeExtraction` is append-only, so a facet
  added inside the monolith silently outranks every pass instead of being
  ordered against them.
- **`CODEGRAPH_PY_LOCAL_TYPE_TRACKING` gates local bindings ONLY.**
  `pythonLocalTypeTrackingEnabled` (exported from `walker/walker.ts`) suppresses
  the walker's `localBindings` and the pass's `param` / `local` facts. It does
  NOT gate `classFieldTypes`, which the walker builds unconditionally and the
  pass extends. Why: flipping the flag to isolate a local-typing regression must
  not silently take the self-field channel with it.

## Mechanics

- **Two coordinate conventions live side by side.** `classFieldTypes` is keyed
  by class SHORT name with a bare member name (`walker/walker.ts:201` and the
  pass's `pythonTypeChannels` both write that shape);
  `structuredReturnTypes` is keyed by the callee's full symbolId
  (`Outer.Inner#method`). The channel re-keying that reconciles them with the
  kernel store's Ruby-shaped output is in `passes/python-type-channels.ts`, and
  the reasoning is in `domains/language/CLAUDE.md` → Mechanics.
```

- [ ] Commit: `docs(language): record the Python type-fact facet in the navigators (9fgdi)`.

---

## Self-review

Run this before declaring the plan executed.

**Names are identical across tasks.** Every symbol below is defined exactly once
and referenced by that spelling everywhere else:

| Symbol | Defined in | Read by |
| --- | --- | --- |
| `PYTHON_DECLINED_TYPE_NAMES`, `pythonBareTypeName`, `pythonTypeRefFromNode`, `pythonTypeRefFromText`, `pythonNominalReceiverName` | Task 1, `python-type-annotation.ts` | Tasks 2, 3 |
| `PythonDefSite`, `PythonAnnotatedAssignmentSite`, `PythonScopeVisitor`, `walkPythonScopes`, `pythonAnnotationExpression`, `isPythonClassFormDef` | Task 2, `python-def-scope-walk.ts` | Tasks 2, 3 |
| `PYTHON_ANNOTATION_SOURCE`, `PythonTypeSourceInput`, `pythonAnnotationTypeSource` | Task 2, `python-annotation-type-source.ts` | Tasks 3, 4 |
| `pythonLocalTypeTrackingEnabled` | Task 2, `walker/walker.ts` (renamed + exported) | Task 4 |
| `PYTHON_DOCSTRING_SOURCE`, `pythonDocstringTypeSource`, `pythonDocstringText` | Task 3 | Task 4 |
| `pythonStructuredReturnKey`, `pythonTypeChannels` | Task 4, `python-type-channels.ts` | Task 4 |
| `PYTHON_TYPE_SOURCE_ORDER`, `PYTHON_INLINE_TYPE_SOURCES`, `pythonAnnotationTypeFacetPass` | Task 4, `annotation-type-facts.ts` | `walker/passes.ts` |

**No undefined symbol.** Everything else the code names is imported from a file
that exists today: `AstNode` (`contracts/types/ast.ts`), `TypeRef` /
`WalkContext` (`contracts/types/language.ts`), `FileExtraction`
(`contracts/types/codegraph.ts`), `TypeFact` / `InlineTypeSource`
(`kernel/type-facts.ts`), `TypeFactStore` (`kernel/type-fact-store.ts`),
`typeFactChannels` (`kernel/type-fact-channels.ts`), `NIL_TYPE_REF` /
`typeRefUnionOf` / `typeRefReceiverForm` (`kernel/type-ref.ts`),
`ExtractionFacetPass` (`kernel/extraction-passes.ts`). Import depth from
`python/walker/passes/` is five levels to `contracts/` and three to `kernel/`.

**Every decision has a task.**

| Decision | Where it lands |
| --- | --- |
| 1 — one pass, monolith untouched but for the env-gate export | Task 2 (rename/export), Task 4 (pass + registration) |
| 2 — emit only what `extractTypeName` declines | Task 2 (`walkerAlreadyBinds`), tested by the first two rows of Task 2's fixture table |
| 3 — sources, ranks, disjointness | Tasks 2 and 3; the rank pinned by Task 4's hand-built collision |
| 3 (mapper) — the full `TypeRef` form table incl. `dict[K,V]` → `container(V)` | Task 1, table test |
| 4 — single nominal arm gates receiver bindings | Task 1 (`pythonNominalReceiverName`), enforced in Tasks 2 and 3 |
| 5 — channel re-keying and the dropped flat map | Task 4 (`pythonTypeChannels`) |
| Gates | Task 5 |

## Open items this plan does NOT close

- **`structuredReturnTypes` has no Python reader yet.** The channel is filled on
  five corpora after this seam and consumed by nobody until the receiver-type
  propagation seam. That is deliberate (decision 5), but it means the oracle
  A/B measures the `param` / `local` / `classFieldTypes` half of the lever only.
  Expect `annotationReturn` `missed` to drop by less than its 2,829 headline
  until propagation lands — the category flags any site whose enclosing function
  has a return annotation, which on polar is 80,619 of 82,554 sites, so most of
  those losses are about the RECEIVER at the site, not about the return type.
- **`decoratorProperty` is untouched.** `@property` receivers are pull-order
  entry 4 and the next seam after this one; `walkPythonScopes` already collects
  decorator names, which is the substrate that seam needs.
- **SQLAlchemy `Mapped[Foo]` and Django `QuerySet[Foo]` stay wrapped.** The
  mapper keeps the base as the receiver, which is the honest reading of the
  annotation. Unwrapping them is E3 `FrameworkModule` data, gated on
  `pyproject.toml`, not a guess in the kernel-facing mapper.
- **`"ast"` is a declared rank with no source behind it.** Relocating the
  walker's constructor inference into a pass is its own seam, and nothing here
  depends on it happening.
