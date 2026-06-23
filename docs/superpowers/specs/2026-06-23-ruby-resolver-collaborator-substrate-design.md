# Cross-Language Call-Resolver Collaborator Substrate — Design

**Status:** approved (brainstorm 2026-06-23) **Epic:** `tea-rags-mcp-cai0` (Ruby
resolver precision), child of `duzy` **Worktree:**
`.claude/worktrees/ruby-dsl-decomposition` at main `c5af636b`

## Goal

Decompose the two remaining inline responsibilities of `RubyCallResolver` into
generic cross-language engines + per-language injected collaborators, so the
substrate is ready for python/ts/js/go to migrate onto later. Ruby is the pilot
implementation NOW; the other four languages migrate in a follow-up (Non-Goal
here). No behaviour change — this is a structural refactor; the resolve metric
must stay byte-identical.

## Ground-truth context (why the scope is what it is)

`RubyCallResolver` (`src/core/domains/language/ruby/resolver/ruby-resolver.ts`,
~160 LOC) is already a thin facade implementing the `CallResolver` contract
(`contracts/types/codegraph.ts:546`). Of its four responsibilities, **two are
already substrate-decomposed**:

| Method                  | State                | Existing substrate                                                                                                                                                                   |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve`               | ✅ already substrate | `resolveViaChain(strategies[])` — generic engine (`domains/language/resolver-chain.ts`) + per-language `SymbolResolutionStrategy[]` (8 strategies in `strategies/`)                  |
| `resolveDispatch`       | ⚠️ half              | `ConeDispatchResolver` already generic (+ injected `ConeTypeLocator`); `table`/`dynamic` still Ruby; the 3-way precedence-compose (`table→cone→dynamic`) is **inline** in the method |
| `targetsExternalImport` | ❌ inline, Ruby      | reads `RUBY_KERNEL_BUILTINS ∪ RUBY_DSL ∪ RAILS_RUNTIME_BUILTINS` + `resolveConstant`                                                                                                 |
| `resolveFileEdges`      | ❌ inline, Ruby      | 30 LOC, 3 channels (require / zeitwerk / inheritance) — channels are language-specific                                                                                               |

**Scope decision (user):** generalise only the two proven-worth surfaces —
`resolveDispatch` composition and `targetsExternalImport` classification.
`resolveFileEdges` stays a Ruby method (its channels are language-specific;
generalising now is premature, YAGNI). This mirrors the existing
`cha-cone-unification` precedent: a generic engine in `domains/language/` with
per-language bits injected via a small interface in
`contracts/types/language.ts`.

The two seam contracts — `CallResolver` (`codegraph.ts:546`) and its mirror
`LanguageSymbolResolver` (`language.ts:339`) — are the 5-language surface and
stay **immutable**. The engines are internal to the resolver; the only additive
contract change is a new injected interface (`ExternalVocabulary`), parallel to
the existing `ConeTypeLocator`. `DispatchResolverComponent` (`language.ts:83`)
already exists and is reused as-is.

## Architecture

### 1. Dispatch-composition engine (generic)

`resolveDispatchViaComponents(components, call, ctx)` — a function in
`domains/language/resolver-chain.ts`, sibling to `resolveViaChain`. Runs an
ordered `DispatchResolverComponent[]` and returns the first non-empty
`DispatchEdge[]`, else `[]`. It is the fan-out mirror of `resolveViaChain`
("decisive" = non-empty here; precedence = array order).

```ts
export function resolveDispatchViaComponents(
  components: readonly DispatchResolverComponent[],
  call: CallRef,
  ctx: CallContext,
): DispatchEdge[] {
  for (const component of components) {
    const edges = component.resolveDispatch(call, ctx);
    if (edges.length > 0) return edges;
  }
  return [];
}
```

Behaviour identity: the current inline `table→cone→dynamic` (each
`if (x.length > 0) return x`, falling through to `return this.dynamic...`) is
exactly first-non-empty-wins over `[table, cone, dynamic]`. The last component's
result is returned whether empty or not, so `return dynamic` ≡
`if (dynamic.length>0) return dynamic; return []`.

### 2. External-classification engine (generic) + injected vocabulary

`ExternalCallClassifier` — a class in `domains/language/external-classifier.ts`.
The engine owns the language-neutral receiver-shape branch (null bare-call vs
qualified receiver); the per-language predicates are injected via
`ExternalVocabulary`. Mirrors `ConeDispatchResolver` (engine = structure,
injected = language primitives).

```ts
export class ExternalCallClassifier {
  constructor(private readonly vocab: ExternalVocabulary) {}
  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    return call.receiver === null
      ? this.vocab.isBareCallExternal(call.member)
      : this.vocab.isQualifiedReceiverExternal(call.receiver, ctx);
  }
}
```

New injected interface in `contracts/types/language.ts` (additive, beside
`ConeTypeLocator`):

```ts
export interface ExternalVocabulary {
  isBareCallExternal(member: string): boolean;
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean;
}
```

`isBareCallExternal` (member-name set membership) and
`isQualifiedReceiverExternal` (`/^[A-Z]/` Ruby-constant lexis +
`resolveConstant`) are split because the constant-vs-local lexical test is
language-specific (Python/Go classify "qualified receiver" differently); a
uniform two-method contract keeps that out of the engine.

### 3. Framework-vocabulary registry (open-closed over frameworks)

The bare-call external vocabulary is **a facet of each framework module**, not a
hand-maintained disjunction in the resolver. Today `dsl/` already decomposes the
DSL catalogue per framework (`ruby-core.ts` / `activesupport.ts` / `rails.ts`,
each a `RubyDslModule`, merged by `composeModules`). We broaden that module so
it owns its full external-callable surface — declaring macros AND non-declaring
runtime helpers — and expose membership polymorphically.

```ts
// dsl/types.ts — broadened from RubyDslModule
export interface RubyFrameworkVocabulary {
  readonly framework: string; // "ruby-core" | "activesupport" | "rails"
  readonly entries: Record<string, RubyDslEntry>; // class-body declaring macros (has_many, validates)
  readonly runtimeBuiltins?: ReadonlySet<string>; // non-declaring helpers (params/render; puts/raise/require)
  hasExternalMember(member: string): boolean; // polymorphic membership — hides storage shape
}
```

```ts
// dsl/framework-module.ts — membership logic lives ONCE (factory, not container)
export function defineFrameworkVocabulary(
  framework: string,
  entries: Record<string, RubyDslEntry>,
  runtimeBuiltins?: ReadonlySet<string>,
): RubyFrameworkVocabulary {
  return {
    framework,
    entries,
    runtimeBuiltins,
    hasExternalMember: (m) =>
      m in entries || (runtimeBuiltins?.has(m) ?? false),
  };
}
```

```ts
// dsl/ruby-core.ts / rails.ts — each framework encapsulates both macros and runtime
export const RUBY_CORE_VOCABULARY = defineFrameworkVocabulary(
  "ruby-core",
  RUBY_CORE_ENTRIES,
  RUBY_KERNEL_BUILTINS,
);
export const RAILS_VOCABULARY = defineFrameworkVocabulary(
  "rails",
  RAILS_ENTRIES,
  RAILS_RUNTIME_BUILTINS,
);
```

```ts
// dsl/catalogue.ts — registry = the existing composition point, broadened
const FRAMEWORKS: readonly RubyFrameworkVocabulary[] = [
  RUBY_CORE_VOCABULARY,
  ACTIVESUPPORT_VOCABULARY,
  RAILS_VOCABULARY,
];
export const RUBY_DSL = composeEntries(FRAMEWORKS); // macro lookup (unchanged behaviour)
export const isExternalBareCall = (m: string): boolean =>
  // NEW — fold over the registry
  FRAMEWORKS.some((f) => f.hasExternalMember(m));
```

`RUBY_KERNEL_BUILTINS` moves into the ruby-core vocabulary;
`RAILS_RUNTIME_BUILTINS` into the rails vocabulary. The standalone
`kernel-builtins.ts` / `rails-runtime.ts` constant files are absorbed (the raw
`Set`s may stay as the module's data source, but the resolver no longer
references them — it references the registry of module implementations via
`isExternalBareCall`).

**Registry form — decided.** A typed `FRAMEWORKS` array (not a self-registering
base class). Rationale: resolver-level OCP is satisfied either way (the resolver
never changes for a new framework — it calls `isExternalBareCall`). The choice
is only the _form of the irreducible framework manifest_. In ESM, class
declaration does not register anything; self-registration needs instantiation +
a central side-effect import barrel that is equivalent in edit-cost to the
array. The array is type-checked, greppable, immutable, has no hidden mutable
static state, and matches the established `composeModules` house style (and the
`domains-language` factory-not-container rule). Adding a framework = one new
module file + one line in `FRAMEWORKS` → its external vocabulary is live
automatically, **zero resolver or predicate edits**.

### 4. Ruby vocabulary adapter

`RubyExternalVocabulary` in `resolver/ruby-external-vocabulary.ts` implements
the injected `ExternalVocabulary` by bridging the `dsl/` registry with the
resolver's `resolveConstant`:

```ts
export class RubyExternalVocabulary implements ExternalVocabulary {
  isBareCallExternal(member: string): boolean {
    return isExternalBareCall(member); // registry fold — no constants
  }
  isQualifiedReceiverExternal(receiver: string, ctx: CallContext): boolean {
    return /^[A-Z]/.test(receiver) && resolveConstant(receiver, ctx) === null;
  }
}
```

It lives in `resolver/` (not `dsl/`) because it needs the resolver's
`resolveConstant` from `strategies/` — it is the dsl↔resolver bridge, not pure
data.

### 5. Facade after refactor (`RubyCallResolver`)

The `CallResolver` signature is unchanged; the body shrinks:

- constructor wires `dispatchComponents = [table, cone, dynamic]` and
  `externalClassifier = new ExternalCallClassifier(new RubyExternalVocabulary())`.
- `resolve` → `resolveViaChain(this.strategies, call, ctx)` — **unchanged**.
- `resolveDispatch` →
  `resolveDispatchViaComponents(this.dispatchComponents, call, ctx)`.
- `targetsExternalImport` →
  `this.externalClassifier.targetsExternal(call, ctx)`.
- `resolveFileEdges` → **unchanged** (stays a Ruby method).

## Migration order & TDD discipline

Hybrid: the new engines are **net-new** (red→green TDD; new units get new tests
— the relocation rule explicitly allows tests of new entities); the facade
re-wiring is **relocation** (move code, behaviour byte-identical, existing
business-logic tests stay green and are NOT rewritten — rule
`feedback_refactor_migration_test_order`).

Bottom-up so every step keeps the build green; the facade switches only once the
engines exist and are tested:

1. **Net-new** — `ExternalVocabulary` (contracts) + `ExternalCallClassifier`
   (domains/language) + unit test (null→bare, qualified→qualified via a fake
   vocab).
2. **Net-new** — `resolveDispatchViaComponents` (domains/language) + unit test
   (first-non-empty-wins; all-empty → `[]`).
3. **Net-new + relocation** — `RubyFrameworkVocabulary` +
   `defineFrameworkVocabulary`
   - `isExternalBareCall` (dsl/) + unit test (`hasExternalMember` over entries ∪
     runtimeBuiltins; registry fold). Relocate `RUBY_KERNEL_BUILTINS` →
     ruby-core vocabulary, `RAILS_RUNTIME_BUILTINS` → rails vocabulary (preserve
     existing example assertions).
4. **Net-new** — `RubyExternalVocabulary` (resolver) + unit test (delegates to
   `isExternalBareCall` + `resolveConstant`).
5. **Relocation** — `RubyCallResolver` constructor wiring + `resolveDispatch` /
   `targetsExternalImport` delegate. Existing `ruby-resolver-dispatch.test.ts`
   and `ruby-resolver-external-import.test.ts` stay green untouched (the
   regression net).
6. **Cleanup (last)** — remove orphaned standalone files if fully absorbed;
   redistribute their tests last.

## Deliverable: `.claude/rules/resolver-architecture.md`

A new project rule (with the mandatory `paths:` frontmatter) codifying _how to
write a call resolver correctly_, so future language resolvers follow the
substrate instead of regrowing a god-class. Authored as the **last** plan task —
it documents the pattern as it actually landed, referencing real files.

`paths:` scope:

```yaml
paths:
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/external-classifier.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/language/*/resolver/**"
  - "src/core/domains/language/*/dsl/**"
  - "src/core/contracts/types/language.ts"
  - "tests/core/domains/language/*/resolver/**"
```

Rule content (the load-bearing principles):

1. **Facade implements the immutable `CallResolver` contract.** The 4 methods
   (`resolve` / `resolveDispatch?` / `resolveFileEdges?` /
   `targetsExternalImport?`) are the 5-language seam; never change the signature
   to decompose — extract collaborators _behind_ it. `CallResolver` and its
   mirror `LanguageSymbolResolver` stay in lockstep.
2. **Responsibilities are generic engines + injected per-language
   collaborators** (the cone-dispatch precedent), NOT methods on the facade:
   - resolution chain → `resolveViaChain(SymbolResolutionStrategy[])`
   - dispatch fan-out →
     `resolveDispatchViaComponents(DispatchResolverComponent[])` and
     `ConeDispatchResolver(ConeTypeLocator)`
   - external classification → `ExternalCallClassifier(ExternalVocabulary)` The
     engine owns language-neutral structure; the injected interface owns the
     language primitives. Engines live in `domains/language/`; injected
     interfaces live in `contracts/types/language.ts`.
3. **No inline disjunction over data constants.** A classifier must fold over a
   typed registry of polymorphic sources
   (`FRAMEWORKS.some(f => f.hasExternalMember(m))`), never
   `A.has(m) || m in B || C.has(m)`. Vocabulary is a facet of the framework
   module; adding a framework = one module + one registry line, zero resolver
   edits.
4. **Registry form is a typed array, not self-registration.** ESM class
   declaration registers nothing; self-registration needs a side-effect import
   barrel equivalent in cost to the array but untyped + stateful. The typed
   array is the house style (`composeModules`, factory-not-container).
5. **Refactoring discipline.** Extracting a responsibility into an engine is
   relocation: behaviour byte-identical, existing business-logic tests stay
   green untouched (move OK, rewrite NO); new engines (new entities) get new
   red-green unit tests. The resolve metric must not move.

## Regression net & quality gates

**Immutable tests (must stay green byte-for-byte through the whole migration):**

- `ruby-resolver-dispatch.test.ts` — `resolveDispatch` end-to-end (cone
  composition, wbj3) → catches a composer regression.
- `ruby-resolver-external-import.test.ts` — `targetsExternalImport` (kernel /
  dsl / rails / constant; all cai0 cases) → catches a classifier regression; the
  strongest net for external behaviour.
- `ruby-resolver.test.ts` (resolve chain, send-dispatch) — untouched.

**Gates:** `npx vitest run` green, `tsc` 0 errors, ESLint 0 (no `disable`),
coverage threshold not lowered.

**Live huginn — optional, post-merge.** One reindex confirming `byReceiverKind`
/ `resolveSuccessRate` did **not** move (a behaviour-identical refactor must
leave the metric unchanged). Safety only, not required; no duplicate measurement
(determinism already confirmed).

## Non-Goals

- Migrating python/ts/js/go resolvers onto the substrate now (the substrate is
  built for them; their implementation is a follow-up).
- Generalising `resolveFileEdges` (channels are language-specific; YAGNI).
- Honest-denominator Phase 2 (`tea-rags-mcp-qdisn`) — separate track. The
  `origin`/framework attribution that the registry could expose is a future seam
  for that work, not built here.
- Merging the two mirror contracts `CallResolver` / `LanguageSymbolResolver` —
  pre-existing duplication, out of scope.

## Affected files

**New:**

- `domains/language/external-classifier.ts` (`ExternalCallClassifier`)
- `domains/language/ruby/dsl/framework-module.ts` (`defineFrameworkVocabulary`)
- `domains/language/ruby/resolver/ruby-external-vocabulary.ts`
  (`RubyExternalVocabulary`)
- `.claude/rules/resolver-architecture.md` (the resolver rule — authored last)

**Modified:**

- `domains/language/resolver-chain.ts` (+`resolveDispatchViaComponents`)
- `contracts/types/language.ts` (+`ExternalVocabulary` interface)
- `domains/language/ruby/dsl/types.ts` (`RubyDslModule` →
  `RubyFrameworkVocabulary`)
- `domains/language/ruby/dsl/catalogue.ts` (`FRAMEWORKS`, `isExternalBareCall`)
- `domains/language/ruby/dsl/ruby-core.ts`, `rails.ts` (own `runtimeBuiltins`)
- `domains/language/ruby/resolver/ruby-resolver.ts` (facade delegates)

**Relocated/absorbed:**

- `resolver/kernel-builtins.ts` → ruby-core vocabulary
- `dsl/rails-runtime.ts` → rails vocabulary
