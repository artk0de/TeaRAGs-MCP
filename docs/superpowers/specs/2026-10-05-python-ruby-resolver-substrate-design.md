# Python ↔ Ruby resolver substrate: Ruby-parity strategies for Python, shared mechanics in the kernel

**Date:** 2026-10-05 **Status:** design approved (sections 1–3), awaiting spec
review **Parent epic:** `tea-rags-mcp-m99j1` (Codegraph precision + recall
roadmap, LSP-free) **Hardening sink:** `tea-rags-mcp-0qaht` **Base:** `main`
after `integration/arch-fixes-2026-10-04` lands. That branch moves
`ConeDispatchResolver` into `kernel/` and edits
`python/resolver/strategies/shared.ts`. Every path below assumes its layout.

## 1. Problem

The django index (`swe-django__django-11039`, 680 scored Python files) reports a
Python `resolveSuccessRate` of 0.602. Three layers sit under that number:

| Layer                                                           | Genuine misses | Source                                       |
| --------------------------------------------------------------- | -------------- | -------------------------------------------- |
| Production index                                                | 5193           | `cg_file_resolve_stats` / `prime`            |
| Same code, offline chain (`codegraph-chain-tally --kind-stats`) | 3598           | rate 0.725                                   |
| Misses the jedi oracle can place in the project                 | 676            | `py-codegraph-jedi-oracle.ts`, chain drift 0 |

**Layer 1 — production vs offline.** The 0.602 → 0.725 gap is a production
defect:

- In production, `super` resolves 2 of 919 calls; offline it resolves 791.
  `selfMember` resolves 2644 in production and 3250 offline.
- The production graph carries only same-file `super` edges.
- flask and ugnest match offline exactly. They are below
  `INGEST_TUNE_ENRICHMENT_FILES_PER_THREAD` (400), so their pass-1 extraction
  never fans out; django does.
- The suspect is the fan-out extraction path. It is tracked separately (§7,
  wave 0) and is not part of this design.

**Layer 2 — oracle-decidable misses (676).** Oracle-anchored recall is 0.928:

- by receiver kind: dynamic 385, chain 167, bareCall 99;
- `super` (0.997) and `selfMember` (0.998) are already at the ceiling offline.

**Layer 3 — the remaining ~2920 metric misses.** jedi either calls them external
or cannot answer them either. They are a denominator problem, not a resolver
problem.

At the same time, Python and Ruby implement the same mechanisms twice:

- dynamic fan-out, table dispatch, chain-type, local binding, convention
  receiver;
- bound-call return fold, member-return-through-MRO;
- framework-vocabulary registry, manifest gate, resolver config.

Ruby also owns mechanisms Python lacks: union dispatch, receiver-set drop,
call-arg → param typing, association types, relation/instance-returning
vocabulary.

## 2. Goals and non-goals

**Goals**

1. Every Ruby-side resolution mechanism is available to Python, through a kernel
   contract both languages implement.
2. Python-specific mechanics close the oracle-decidable gap, with a precision
   gate per increment.
3. Ruby behavior stays byte-identical through every lift.
4. The denominator stops counting calls that are provably external or statically
   undecidable.

**Non-goals**

- An LSP or type-checker dependency in production. jedi and pyright remain
  offline instruments.
- A unified dataflow / worklist type-inference engine (approach C). It is
  rejected until the port-based design hits its ceiling.
- Fixing the production fan-out divergence. That is a separate bead (§7, wave
  0).
- Django scalar-field typing and reverse relation accessors (YAGNI).

## 3. Approach

The approach is **contracts first, then the Ruby lift, then the Python fill**:

- The kernel owns the _engine_: step order, folds, declines, caps.
- A language owns _ports_: how to type a receiver, how to find a member on a
  type. It also owns _data_: vocabularies, gate predicates, patterns.

This continues the pattern the kernel already uses:

- `propagateReceiverType` + `ReceiverTypePorts`;
- `ConeDispatchResolver` + `ConeTypeLocator`;
- `conventionClassNameFor` + `NamingConventionPorts`;
- `inferReturnTypeName` + `ReturnInferencePorts`;
- `TypeFactStore`, `buildDispatchCascade`.

Rejected alternatives:

- **B — port Python first, extract later.** It duplicates the code until a later
  refactor that never gets cheaper.
- **C — fixpoint inference engine.** It is net-new design that forfeits the Ruby
  port and risks the precision gate.

## 4. Kernel contracts (section 1)

### 4.1 Central port: `TypeMemberLookup`

Signature:
`(typeRef: TypeRef, member: string, ctx: CallContext) => SymbolResolutionTarget | null`.

- The MRO / ancestor walk lives inside the port implementation.
- It replaces, for strategies built on the kernel skeletons:
  - Ruby `resolveTypeStaticMethod` / `resolveTypeInstanceMethod`;
  - Python `resolvePythonMemberOnType` / `resolvePythonMemberOnTypeThroughMro`.
- K2–K6 depend on it.

### 4.2 Contract table

| #   | Kernel contract                                                                                                                                                                                                                               | Responsibility                                                                                 | Ruby                                                                                            | Python                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| K1  | `DynamicDispatchResolver` + `DynamicDispatchPorts` (`suppressed`, `lookupByShortName`, cascade options, discount, population, cap) + `ExactChainAnswerProbe`                                                                                  | Short-name fan-out narrowed by the kernel cascade                                              | `RubyDynamicDispatchResolver` becomes ports; `rubyDynamicFanoutSuppressed` keeps its gate order | `PythonDynamicDispatchResolver` becomes ports; enabling it is wave 3                   |
| K2  | `UnionDispatchResolver`                                                                                                                                                                                                                       | Union receiver → member per arm; 1/N `cone`; drop above `coneMax`                              | lifted from `RubyUnionDispatchResolver`                                                         | **new consumer**                                                                       |
| K3  | `TableDispatchResolver` + ports `selectTableDef` / `resolveEntry`                                                                                                                                                                             | Dispatch-table fan-out over `CallRef.dispatch` / `ctx.dispatchTables`                          | lifted                                                                                          | lifted                                                                                 |
| K4  | `ChainTypeSymbolResolutionStrategy`, `LocalBindingSymbolResolutionStrategy`, `ConventionReceiverSymbolResolutionStrategy`                                                                                                                     | Type the receiver → member on the type → `DROP` on miss                                        | three Ruby classes become instances                                                             | three Python classes become instances                                                  |
| K5  | `ReceiverPatternDropSymbolResolutionStrategy` (data: patterns)                                                                                                                                                                                | `DROP` by receiver shape                                                                       | `receiverSetDrop` + `arRelationGuard`                                                           | new consumer (QuerySet shapes)                                                         |
| K6  | `MemberReturnTypeResolver` + unified `CallContext.callResultBindings`                                                                                                                                                                         | declared → inherited (linearizer) → flat (≤ 1 def) → framework-vocabulary hook                 | `returnTypeOf`; `localCallBindings` renamed into the unified channel                            | `pythonInheritedMemberType` / `pythonCallBindingType`                                  |
| K7  | `kernel/call-arg-param-types.ts` (moved from `trajectory/codegraph/symbols/`, keeping `foldKnownTargetParamTypes` / `deriveClassFieldTypesFromParams` / `seedParamLocalBindings`; field keys via `ClassFieldKeyPort`, kernel `typeRefEquals`) | Param type = agreed type of the arguments known calls pass; `self.x = param` fields inherit it | producer stays                                                                                  | **walker starts emitting** `knownTargetCallArgs`, `classFieldParamLinks`, `paramNames` |
| K8  | `FrameworkVocabularyRegistry<V>` (define / filter / compose / memo); activation only through `DependencyManifestSource`                                                                                                                       | Framework vocabularies gated by manifests                                                      | **Gemfile becomes a `DependencyManifestSource`; the `gemfileContent` channel is retired**       | lifted                                                                                 |
| K9  | `readResolverConfig(envPrefix)`                                                                                                                                                                                                               | `ResolverConfig`, `CONE_MAX_DEFAULT`, env parsing                                              | lifted                                                                                          | lifted                                                                                 |
| K10 | `AncestorLinearizerCache` on `RunScopedMemo`; member-in-MRO only through `findMemberInAncestorChain`                                                                                                                                          | Run-memoised linearization                                                                     | **gains the memo**                                                                              | already uses it                                                                        |
| K11 | Facade hook `targetsUndecidable(call, ctx)` + walker flag `CallRef.dynamicSend`                                                                                                                                                               | Undecidable calls leave the denominator (`unresolvable`)                                       | later: `method_missing`                                                                         | §5 P6                                                                                  |
| K12 | `ExternalVocabulary` arm: a receiver typed to an external type → external                                                                                                                                                                     | Prove external by type                                                                         | optional                                                                                        | §5 P7                                                                                  |
| T   | `TypeRef` gains `{ form: "tuple"; elements: TypeRef[] }`                                                                                                                                                                                      | Positional element types                                                                       | —                                                                                               | P1 unpacking                                                                           |

### 4.3 Explicitly NOT in the kernel

Anything whose _semantics_ are Python-only lives in `python/` as ports over K4 /
K6:

- iteration and context-manager protocols;
- callable-value flow;
- descriptors;
- module-level singletons;
- Django content.

## 5. Python-specific mechanics (section 2)

The walker emits facts; the resolver consumes them through existing ports.
Counts are the oracle residual on django, estimated from samples. The plan
re-measures them on the post-merge base.

| #   | Mechanism                                      | Residual      | Walker                                                                                                                                    | Resolver                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Iteration / context / unpack / except bindings | ~85           | `LocalBinding.valueKind` adds `iterationElement(expr)`, `contextEnter(expr)`, `tupleElement(expr, i)`, `exceptionInstance(Class)`         | **Kernel `iterationElement` kind**, port `elementTypeOf(typeRef, ctx)`. Python: container element, else `__iter__` → `__next__` via K6, plus a built-in container table (`dict.values/items/keys`, `enumerate`, `zip`, `reversed`). `contextEnter` → `__enter__` return via K6; `Self` / `return self` yields the operand |
| P2  | Callable-value flow                            | ~80           | `@d def f` emits an implicit `d(f)` call; every call passing a function reference to a param feeds `callbackParams`                       | `cls(...)` / `type(self)(...)` / `self.__class__(...)` → enclosing-class constructor, inside `clsMember`. `param(...)`: one source → exact; several → fan under the `fanout-policy` cap, never exact                                                                                                                      |
| P3  | Descriptors                                    | ~50           | A def is an attribute when its decorator is in the descriptor vocabulary (`property`, `functools.cached_property`, framework-contributed) | `ReceiverTypePorts.memberTypeOf` reads the attribute's return type                                                                                                                                                                                                                                                        |
| P4  | Module-level values                            | ~130          | Module-level assignment from a constructor call → `moduleValueType` fact keyed `relPath::name`                                            | Import binding → file → `moduleValueType` → `TypeMemberLookup`; same-file module variables take the same path. Kernel channel `moduleValueTypes` in `TypeFactStore`                                                                                                                                                       |
| P5  | Django facets on K8                            | ~40 on django | —                                                                                                                                         | `relationReturning` / `instanceReturning` (shared facet shape with Ruby AR) for Manager / QuerySet methods; `objects` / `_default_manager` / `_base_manager` → Manager (class-body override wins); `_meta` → `Options`; `ForeignKey(X)` / `OneToOneField(X)` → instance of `X` through the association channel            |
| P6  | Undecidable                                    | denominator   | `dynamicSend` for `getattr(obj, <non-literal>)(...)`                                                                                      | `targetsUndecidable`: typed receiver, member absent on the MRO, class defines `__getattr__` / `__getattribute__` or is created by a metaclass                                                                                                                                                                             |
| P7  | External by type                               | denominator   | —                                                                                                                                         | A field / local typed by a constructor from an external import (`threading.Event()`) is external                                                                                                                                                                                                                          |

**Activation rule for P5.** A framework vocabulary activates when:

- the project's manifests declare the framework, **or**
- the project _is_ that package (`name` in `setup.py` / `pyproject.toml`).

The django repository does not depend on django.

## 6. Precision and identity gates

**Ruby lift (wave 1).** Each lift must leave both of these byte-identical, with
0 lost:

- `codegraph-chain-tally --kind-stats`;
- the method/file edge set, on the Ruby corpora (mastodon, octokit).

`T` (tuple form) additionally requires an unchanged TypeScript oracle
`CHAIN OUTPUT`. A lift that moves any edge is a behavior change: revert it and
investigate.

**Python increment (waves 2–3).**

- **Oracle corpora:** django + flask / httpx / netbox / polar / ugnest, using
  tiebroken precision.
- **Gate:** fabricated + wrongFile ≤ 2% of edges, phantom does not increase,
  per-increment lost 0.
- **Recall check:** recall rises on the mechanism's receiver kind. Recovering
  less than 50% of the predicted residual stops the wave for diagnosis.
- **Rollout:** every mechanism ships behind a flag until it passes.

**Success criteria**

- django oracle-anchored recall ≥ 0.98 overall (target 0.99), and ≥ 0.95 on
  every receiver kind with n ≥ 100, with the precision gate unchanged.
- The production index matches the offline chain (after the wave-0 fix).
- `resolveSuccessRate` is reported, not gated. Its ceiling is set by the
  denominator work (P6 / P7).

## 7. Delivery

| Wave | Content                                                                                                                                                                                 | Order                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 0    | Land `integration/arch-fixes-2026-10-04`; branch `integration/py-ruby-substrate` from it. Fan-out divergence bead runs in parallel (diagnose the extract path; recompute is user-gated) | prerequisite                |
| 1    | `TypeMemberLookup` + K4 + `T` first, serial; then K1, K2, K3, K5, K6, K7, K8, K9, K10 in parallel over disjoint files                                                                   | Ruby identity gate per lift |
| 2    | Python consumption, by expected gain: P4 → K6-python → K7-feed → P1 → P2 → P3 → P5 → K2 → K5 → P6 / P7                                                                                  | oracle gate per increment   |
| 3    | Python dynamic dispatch (K1 ports) as its own sub-epic; default-on only when the precision gate passes on all six corpora                                                               | precision gate              |
| 4    | Live validation, user-gated: `--force-enrichments codegraph` on django and one Ruby project, then `prime`. Walker version bumped once per release                                       | user-gated                  |

### Execution rules

- **Agents.** Implementation runs in Opus subagents, at most **3 concurrently**,
  each in its own worktree branched from the integration branch.
- **Agent tests.** A subagent runs only the tests related to its change:
  targeted vitest files, `tsc`, and the gate harness for its increment.
- **Full suite.** The full vitest suite runs once, on the integration branch,
  after each wave (or another large chunk) merges.
- **Self-review, after the task.** Once a task is implemented and its related
  tests are green, the subagent runs `review_changes` (all sections) over its
  own diff, fixes its own findings, re-runs the related tests, and only then
  reports.
- **Findings outside the agent's scope:**
  - in another area → a bead under hardening epic `tea-rags-mcp-0qaht`;
  - Python but outside the agent's task → a follow-up bead under this program's
    epic. Follow-ups are in scope and must be done.
- **Parent validation.** The parent session re-runs `tsc`, the targeted tests
  and the gate harness on every agent report before merging it into the
  integration branch.

### Tests

- TDD for every kernel contract: each engine is tested with fake ports.
- Python mechanics are tested on minimal fixtures plus the oracle.
- Existing Ruby business-logic tests move with their code and are never
  rewritten.
- `tests/navigator-enumerations.test.ts` is updated, and
  `npm run gen:lang-compat` regenerated.
- Navigators under `language/` and `language/python/` name contracts and never
  enumerate implementers.

## 8. Risks

| Risk                                                       | Signal                                                                                   | Mitigation                                                                      |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| K1 touches the main hotspot                                | `ruby-dynamic-dispatch.ts` `resolveDispatch`: 18 commits on one chunk, relativeChurn 9.4 | Lift last within wave 1; gate order preserved verbatim                          |
| K4 / K6 cut the `python/resolver/strategies/shared.ts` hub | 1089 lines, fanIn 18                                                                     | Split it by concern (lookup / class keys / MRO / return facts / import binding) |
| `T` widens a cross-language type                           | Exhaustive `switch`es over `TypeRef` in ts / swift / go                                  | Serial first step; `tsc` plus the TS oracle chain output as the gate            |
| P2 fans across heavily-reused decorators                   | Precision                                                                                | Never exact above one source; `fanout-policy` cap                               |
| P5 activation on framework-source repos                    | django does not depend on django                                                         | The self-package activation rule                                                |
| Deep-silo files (100% one author)                          | ownership preset                                                                         | Commits touching them carry a `Why:` line (`silo-pairing.md`)                   |

## 9. Estimate

Wall-clock, with parallel agents (budget 3):

- P25: 2 days
- P50: 3 days
- P75: 5 days

The serial parts are the oracle on six corpora per increment and the user-gated
recompute.
