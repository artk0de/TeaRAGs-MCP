# Ruby ivar Type-Inference (Type-Inference Slice 1) — Design

**Bead:** `imass` (cai0 epic — Ruby resolver precision). Slice 1 of the
type-inference epic `jlzro`. Sequenced before `a71lj` (chain return-type) and
`y73hx` (index element-type); parallel to `mv6kx` (bareCall narrowing).

**Goal:** infer the static type of `@ivar` receivers at a call site so calls on
them resolve to a concrete in-project class method — closing the largest
type-inference-addressable Ruby miss bucket (huginn: ivar ~129). localVar (~77)
is already built and is only regression-protected here.

**Hard requirement (user):** the mechanism must be UNIVERSAL — a common
cross-language interface (Ruby pilot now; python/ts/js/go already on it or
deferred). This design satisfies it by COMPLETING an existing universal
interface, not by inventing a new one.

---

## Central thesis — the universal interface already exists

A universal type-inference interface is already live and proven on four
languages: the `CallContext.classFieldTypes` contract
(`Record<className, Record<field, type>>`). Each language's walker populates it;
each language's resolver strategy consumes it:

| Language   | Walker (inference)                            | Resolver strategy (consumer) |
| ---------- | --------------------------------------------- | ---------------------------- |
| TypeScript | `collectClassFieldTypes`                      | `ts-field-type.ts`           |
| Java       | `collectJavaClassFieldTypes`                  | `java-field-type.ts`         |
| Python     | `collectPythonClassFieldTypes` (`self.field`) | `python-self-field.ts`       |
| Rust       | `collectRustStructFieldTypes`                 | `rust-self-field.ts`         |
| **Ruby**   | **— MISSING —**                               | **— MISSING —**              |

Ruby is the only one of the five missing the channel. Ruby `@ivar` is the direct
analog of Python `self.field`. Slice 1 = port the Python pattern to Ruby, making
Ruby the 5th implementation of an already-universal interface.

A new `TypeInferenceEngine` + injected `TypeInferenceProvider` (the
ConeDispatchResolver model) was considered and rejected: it would duplicate the
existing `classFieldTypes` / `localBindings` binding-channel substrate. The
universal interface is a DATA-SHAPE contract (Records on `CallContext` populated
per-language by each walker), not an engine signature — so it does not need a
generic engine to be universal, and it stays stable across the later slices
(`a71lj`, `y73hx`) because they add new channels of the same shape.

This was confirmed by reading the actual code (interrogate, don't generate):
`classFieldTypes` is set per-extraction (`provider.ts:1787`,
`classFieldTypes: extraction.classFieldTypes`) and consumed as
`ctx.classFieldTypes?.[enclosing]?.[field]` (`ts/java/python/rust-*-field.ts`) —
it is **caller-file-local**, never globally merged.

---

## Architecture — three components (port of the Python pattern)

### 1. Walker (inference): `collectRubyIvarFieldTypes(root)`

Lives in `ruby/walker/` (sibling of the existing `local-bindings.ts`).

- Walks each `class` / `module` body; captures `@ivar = Const.new` assignments
  in any method of the class.
- Reuses `constInstanceType` from `local-bindings.ts` (RHS `Const.new` →
  `"Const"`). The uppercase-constant gate is natural in Ruby (a constructor
  receiver is a constant), mirroring Python's CapWords gate (bd m46z) that
  prevents phantom edges from lowercase function callees.
- **Slice boundary:** constructor-instantiation RHS only. NOT method-return
  (`@x = foo.bar` → slice `a71lj`), NOT index/element (`@x = arr[0]` → slice
  `y73hx`). The boundary is enforced by `constInstanceType` returning a type
  only for the constructor form.
- **Key format:** `@`-prefixed (`classFieldTypes["Foo"]["@client"]`), because
  the call-site receiver carries `@client` verbatim.
- **Within-file conflict = last-write-wins**, dropping straight out of the
  `collectPythonClassFieldTypes` precedent ("later writes win, mirroring
  localBindings' last-write-wins discipline"). The channel is file-local, so no
  cross-file merge policy is needed — a class's ivar assignments live in the
  class's own file, and within a single file an ivar receiving two different
  constructor types is rare.
- Output goes into the existing `FileExtraction.classFieldTypes` field. **Zero
  contract change** — Ruby's walker now sets a field every other language's
  walker already sets.

### 2. Resolution (project-typed ivar): `RubyIvarFieldSymbolResolutionStrategy`

Lives in `ruby/resolver/strategies/`. Mirrors
`PythonSelfFieldSymbolResolutionStrategy`.

- Matches a single-ivar receiver `/^@\w+$/` (a chained `@a.b.c` is out of scope
  → `continue`).
- Looks up `classFieldTypes[callerScope.join("::")]["@ivar"]` → type → method.
- **Shared lookup reuse:** the type→method resolution
  (`resolveByLocalTypeInternal`, currently `private` in
  `RubyLocalTypeSymbolResolutionStrategy` — does `resolveConstant` + MRO
  ancestor walk + `prepend` + file-only fallback) is extracted into `shared.ts`
  as `resolveTypeMethod(typeName, member, ctx)`. Both the local-type strategy
  and the new ivar strategy call it — shared logic lives in `shared.ts`, no
  duplication.
- Outcomes (mirror python-self-field's `strategies.test`):
  - type resolves to a project file, method found → `resolved` (`Type#member`)
  - type resolves to a project file, method not found → file-only edge
    (`{ targetRelPath, targetSymbolId: null }`)
  - no recorded type for the ivar → `drop` (never falls through to fabricate —
    guard, like python rjuc)
  - receiver not a single ivar / outside class scope → `continue`

### 3. External routing (gem-typed ivar → honest-denominator)

Extends `RubyExternalVocabulary` (the just-landed cai0 ExternalClassifier
collaborator), NOT the resolution strategy.

- `isQualifiedReceiverExternal` gains a branch for `@ivar` receivers: read
  `classFieldTypes[scope]["@ivar"]`; if the type resolves to `null`
  (`resolveConstant` → no project/Zeitwerk file, i.e. a gem like `Net::HTTP`) →
  classify the call **external** → `externalSkipped`, excluded from the
  resolveSuccessRate denominator, with NO fabricated `Net::HTTP#get` edge.
- Routing lives in the ExternalClassifier — not the resolution strategy —
  because in the resolve loop external classification is a distinct step AFTER
  the chain: the chain fails to resolve (gem not in project) → unresolved →
  `targetsExternalImport` catches it by consulting `classFieldTypes`. This is a
  clean fit with the substrate refactor: both the resolution strategy and the
  external classifier consume the same `classFieldTypes` channel.
- **Strict improvement to the honest denominator:** before ivar inference,
  `@client.get` was an internal-miss (the receiver `@client` is not uppercase,
  so the ExternalClassifier never flagged it). Now that the type is known to be
  a gem, the call is honestly external — a former internal-miss becomes
  `externalSkipped`.
- **Intentional divergence from Python:** Python emits a best-effort `resolved`
  target `<Type>#<member>` for an external field type, inflating its rate. Ruby
  does not, because Ruby has the honest denominator (Phase 1/2 of cai0) and
  Python does not. The universal interface (the `classFieldTypes` shape) is
  unchanged — only the per-language consumer policy differs, which is exactly
  what per-language strategies are for.

---

## Data flow

```
@client = HttpClient.new          walker: collectRubyIvarFieldTypes
   |                              -> FileExtraction.classFieldTypes["Foo"]["@client"] = "HttpClient"
@client.get   (call site)         provider -> CallContext.classFieldTypes
   |
resolve chain -> RubyIvarFieldStrategy: classFieldTypes["Foo"]["@client"] = "HttpClient"
   |                                     -> resolveTypeMethod("HttpClient", "get", ctx)
   |-- HttpClient -> project file  -> RESOLVED  HttpClient#get
   '-- Net::HTTP  -> null (gem)    -> DROP -> targetsExternalImport (reads classFieldTypes) -> externalSkipped
```

---

## Universality across the next slices

- `a71lj` (chain return-type) consumes the existing `localCallBindings` +
  `functionReturnTypes` channels — same contract-shape approach. The extracted
  `resolveTypeMethod` in `shared.ts` is the shared type→method lookup for every
  slice.
- `y73hx` (index element-type) is a future channel of the same shape.
- The interface does not change between slices because it is a data-shape
  contract, not an engine signature. Adding a slice = a new walker collector + a
  new strategy reading a new (or existing) `CallContext` Record.

---

## Testing (TDD — net-new, `resolved` moves UP intentionally)

Unlike the byte-identical substrate refactor, this is net-new resolution
capability: the codegraph `resolveSuccessRate` is expected to RISE. Full
red→green TDD for every net-new unit.

**Net-new (red→green):**

- `collectRubyIvarFieldTypes` — walker test: `@x = Const.new` → type;
  last-write-wins on within-file conflict; lowercase/non-constructor RHS
  skipped; `@a.b` (non-ivar-assignment) skipped.
- `RubyIvarFieldSymbolResolutionStrategy` — resolved / file-only / drop /
  continue / external, by the `PythonSelfFieldSymbolResolutionStrategy`
  `strategies.test` template.
- `RubyExternalVocabulary` ivar-gem branch — `@client : Net::HTTP` → external.

**Regression net (immutable, green untouched — move OK, rewrite NO):**

- `ruby-local-type` strategy tests, `ruby-resolver-dispatch`,
  `ruby-resolver-external-import` stay green through the `resolveTypeMethod`
  extraction. New ivar-external cases are ADDED to
  `ruby-resolver-external-import` (additive only).

**Live validation (post-merge, user-gated):** reindex huginn, confirm ivar
receiverKind rate rises and overall/ruby aggregate moves up; confirm gem-typed
ivars land in `externalSkipped`, not `resolved`.

---

## Files

**New:**

- `src/core/domains/language/ruby/walker/ruby-ivar-field-types.ts` (or colocated
  in `local-bindings.ts` beside `collectLocalBindingsForChunk` /
  `constInstanceType`)
- `src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.ts`
- tests: `ruby-walker` ivar-field cases; `strategies.test` ivar-field block

**Modify:**

- `ruby/walker/walker.ts` — call the collector, set
  `FileExtraction.classFieldTypes`
- `ruby/resolver/strategies/shared.ts` — extract
  `resolveTypeMethod(typeName, member, ctx)`
- `ruby/resolver/strategies/ruby-local-type.ts` — delegate to
  `shared.resolveTypeMethod`
- `ruby/resolver/ruby-external-vocabulary.ts` — `@ivar` gem branch in
  `isQualifiedReceiverExternal`
- `ruby/resolver/ruby-resolver.ts` — DI-wire the new strategy into the
  constructor chain (mirror how cone was wired; the public methods stay
  immutable — the facade is a hub, fanIn 9)
- `ruby/resolver/strategies/index.ts` — barrel export

---

## Non-Goals

- localVar channel (already built via `collectLocalBindingsForChunk` +
  `RubyLocalTypeSymbolResolutionStrategy`) — slice 1 only protects it from
  regression via the `resolveTypeMethod` extraction; the ~77 localVar misses are
  mostly method-return forms addressed by `a71lj`.
- Chain return-type (`a71lj`) and index element-type (`y73hx`) inference.
- bareCall ambiguous short-name narrowing (`mv6kx`, parallel track).
- python/ts/js/go onto the collaborator substrate (`v9k2s`) — they already have
  `classFieldTypes`; nothing to do here.

---

## Global Constraints

- Universal interface = the existing `CallContext.classFieldTypes` data-shape
  contract; Ruby becomes its 5th implementation. No new engine/Provider
  abstraction.
- `CallResolver` (`contracts/types/codegraph.ts`) and `LanguageSymbolResolver`
  (`contracts/types/language.ts`) signatures are IMMUTABLE — the 5-language
  seam. No contract change is required by this slice (`classFieldTypes` already
  exists).
- Business-logic tests are immutable: move OK, rewrite NO. The ruby resolver
  regression suite stays green untouched.
- No eslint-disable; never lower coverage thresholds; no `v8 ignore` shortcut.
- TDD for every net-new unit (red→green). `resolveSuccessRate` is expected to
  rise — this is a behaviour change, not a byte-identical refactor.
- Conventional commits; header <=100 chars; the `ruby-resolver.ts` hub commit
  carries a silo-pairing `Why:` line.
- Worktree `.claude/worktrees/ruby-dsl-decomposition`. Ephemeral branch — do NOT
  push. commit != merge != push. Reindex/live-validation is user-gated.
