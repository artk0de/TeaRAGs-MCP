# TS codegraph node/edge coverage

Status: in progress (brainstorming for a typeChecker-based TS resolver, not yet
a finalized design). Tracks every syntax construct that should produce a
codegraph node or edge for TypeScript, against what the current resolver
(`src/core/domains/language/typescript/resolver/`) already handles.

## Why this doc exists

Ruby's resolver (`src/core/domains/language/ruby/resolver/`) is statistically
complete: ~30 `SymbolResolutionStrategy` classes + a `walker/type-sources/`
layer (YARD, AST inference, AR associations) + a DSL/framework grammar layer
(`ruby/dsl/`) + a 15896-line forensics harness
(`scripts/taxdome-codegraph-recall-forensics.ts`).

TS today: 10 strategy classes under `TSCallResolver`
(`src/core/domains/language/typescript/resolver/ts-resolver.ts`) plus tsconfig
path mapping. No type-source layer, no DSL layer (not needed — TS has no
implicit macro-DSL convention the way Rails does; decorators are explicit
typed constructs the type checker already understands), no measurement
harness. `ts.createProgram`/`typeChecker` are not used anywhere — the resolver
is pure tree-sitter heuristics.

Decisions locked so far in the brainstorm:

- **Program strategy: lazy per-file isolated `ts.Program`.** Built only when
  the tree-sitter chain fails to resolve a receiver AND the receiver kind is
  one that structurally needs type information — not for the whole repo, not
  proactively for the whole file.
- **Oracle mode: typeChecker as ground truth for the fast path.** Scan real
  repos for patterns from the table below, compute the tree-sitter answer AND
  the typeChecker answer for the same call site, diff. Corner cases surface
  automatically instead of requiring hand-authored fixtures per hypothesis
  (Ruby's `runBareDeferOracle`/`runSingleSegOracle` pattern).

Existing type vocabulary this table maps onto: `ReceiverKind` (`constant` |
`localVar` | `selfMember` | `super` | `bareCall` | `ivar` | `chain` | `index` |
`dynamic`, `src/core/domains/trajectory/codegraph/symbols/receiver-kind.ts`),
`MethodEdgeKind` (`exact` | `cone` | `poly-base` | `dynamic` | `registry`,
`src/core/contracts/types/codegraph-graph.ts`), `GraphEdges` (`fileEdges`,
`methodEdges`, `inheritance`, `ambiguousFanouts`, same file).

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | handled by the current tree-sitter walker/resolver, confirmed by a test |
| ✅? | probably handled, not confirmed by a dedicated test — verify before relying on it |
| ⬜ | gap, solvable without typeChecker — plain tree-sitter work |
| 🔶 | gap, needs typeChecker — no amount of AST pattern-matching gets this right |

## A. File/module edges (`GraphEdges.fileEdges`)

| Syntax | Status | Notes |
|---|---|---|
| `import { X } from './y'` | ✅ | named specifier capture (bd `2v16`) |
| `import type { X } from './y'` | ✅ | type-only import filter (bd `m19a`) |
| `import X from './y'` (default) | ✅? | not pinned by a dedicated test |
| `import * as X from './y'` (namespace) | ⬜ | `X.foo()` member access needs the namespace binding threaded into receiver resolution |
| `export { X } from './y'` (re-export) | ⬜ | transitive alias: file A re-exports B, importer of A needs to land on B |
| `export * from './y'` (barrel) | ⬜ | common `index.ts` pattern |
| `import('./y')` (dynamic) | ⬜/🔶 | promise-typed; resolving the awaited value's type needs typeChecker |
| `require('./y')` (CJS interop) | ⬜ | mixed ESM/CJS is common in real repos |
| tsconfig `paths`/`baseUrl` alias | ✅ | `ts-path-mapper.ts` + `ts-config-loader.ts` |
| triple-slash `/// <reference path>` | ⬜ | rare, mostly legacy code |

## B. Call edges (`GraphEdges.methodEdges`, keyed by `ReceiverKind`)

| Syntax | ReceiverKind | Status |
|---|---|---|
| `foo()` bare call | `bareCall` | ✅ (`TSGlobalShortNameSymbolResolutionStrategy`) |
| `this.foo()` | `selfMember` | ✅ (`TSThisMemberSymbolResolutionStrategy`) |
| `super.foo()` / `super()` | `super` | ✅ (bd `3a84`) |
| `obj.foo()`, typed receiver | `chain` | ✅? narrow cone via `TSFieldType`/`TSConeTypeLocator` |
| `obj?.foo()` optional chaining | `chain` | ⬜ — verify the parser doesn't drop the edge on `?.` |
| `arr[i].foo()` computed member access | `index` | ⬜ |
| `obj['foo']()` computed call, string literal | — | ⬜ — literal member name is resolvable without typeChecker |
| `new ClassName()` | — | ✅ (bd `i252`) |
| `` tag`template` `` tagged template | — | ⬜ — rare (styled-components etc.) |
| method passed as value (`arr.map(this.foo)`) | — | ⬜ — no Ruby analog either; nobody resolves this edge today |
| `foo.call(obj, ...)` / `.apply` / `.bind` | `dynamic` | ⬜ — Ruby has a `dynamic` analog for `send` |
| generic call `foo<T>()` | — | 🔶 — signature resolution depends on `T` |
| overloaded function call | — | 🔶 — which of N signatures fires needs `getResolvedSignature` |
| union-typed receiver `(a: A \| B).foo()` | `chain`, fan-out | 🔶 — tree-sitter only ever sees one branch; typeChecker sees both, needs `cone`/`poly-base` fan-out like Ruby's CHA devirtualization |

## C. Receiver-type determination (feeds B, not an edge on its own)

| Mechanism | Status | Needs typeChecker? |
|---|---|---|
| explicit param type annotation | ✅ (bd `x6ta`) | no |
| class field type annotation | ✅ (bd `2yfi`) | no |
| `const x: Foo = ...` explicit | ✅? | no |
| `const x = new Foo()` inferred | ✅? | no — tree-sitter can do this |
| return-type inference via another call (`const x = makeFoo()`) | ⬜ | 🔶 — or duplicate Ruby's body-last-expr heuristic |
| generic instantiation (`Container<Foo>`) | ⬜ | 🔶 |
| structural/duck typing (`{ foo(): void }` type literal) | ⬜ | 🔶 — no nominal class name exists at all |
| union narrowing after `typeof`/`instanceof`/discriminant | ⬜ | 🔶 |
| interface declaration merging (multiple `interface Foo {}` across files) | ⬜ | 🔶 — or a manual merge pass |
| conditional/mapped types | ⬜ | 🔶 — low priority, rarely call-site critical |

## D. Inheritance edges (`GraphEdges.inheritance`)

| Syntax | Status |
|---|---|
| `class A extends B` | ✅ (bd `d29r`, `collectClassExtends`/`collectInheritanceEdges`) |
| `class A implements IFoo` | ⬜ — no body inheritance, but matters for structural dispatch |
| `abstract class` / `abstract method` | ⬜ |
| mixin pattern (`class A extends Mixin(B)`) | ⬜ — analog of Ruby `include` |
| declaration merging via namespace | ⬜ — rare |

## E. TS-specific constructs, no Ruby analog

| Construct | Category | Priority |
|---|---|---|
| Decorators (`@Injectable`, `@Controller`, custom) | metadata edge | medium — typeChecker already sees the decorator factory as an ordinary call; no DSL grammar layer needed (confirmed) |
| JSX (`<Foo prop={x} />`) | call edge (component resolution) | high for frontend repos — sugar over `React.createElement`, same mechanics as import-basename + type resolution |
| Function overload signatures | signature resolution | medium — pure typeChecker territory |
| Namespace/module merging (`namespace Foo {}` × N) | symbol merge | low — rare in modern code |

## Coverage summary

Of ~35 cases: **~12 already solved** by the current tree-sitter chain, **~10
solvable without typeChecker** (just not implemented — `require()`, re-export,
namespace import, computed access, `.call`/`.apply`, method-as-value),
**~10 genuinely need typeChecker** (generics, overloads, union narrowing,
structural typing, interface merging, cross-call return-type inference).

typeChecker is a fallback for ~30% of cases, not a replacement for the
resolver — the design should add it as a narrow last-resort strategy in the
existing `SymbolResolutionStrategy` chain, not restructure the chain around
it.
