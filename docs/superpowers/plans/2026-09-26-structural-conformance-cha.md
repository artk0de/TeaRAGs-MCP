# Structural conformance in the CHA cone — implementation plan

Bead: tea-rags-mcp-39xca.14 (option D). Spec:
`docs/superpowers/specs/2026-09-26-structural-conformance-cha-design.md`.

## Impact enrichment (blastRadius)

| File                                        | Owner   | Churn      | Blast                                                       |
| ------------------------------------------- | ------- | ---------- | ----------------------------------------------------------- |
| `trajectory/codegraph/symbols/run-state.ts` | artk0de | 27 commits | transitiveImpact 46, fanIn 7 — isolate, test at the barrier |
| `trajectory/codegraph/hierarchy-view.ts`    | artk0de | low        | every cone consumer                                         |
| `language/cone-dispatch.ts`                 | artk0de | low        | every language's cone                                       |

## Design decisions made while planning

- **DI.** The barrier gets the kernel deriver the way it gets
  `schemaColumnAccessors`: an optional `LanguageProvider.structuralConformance`
  capability. TypeScript and Python expose the kernel function; the run state
  collects it per language family at construction. A family with no capability
  derives nothing.
- **Owner index.** Built at the barrier from
  `GlobalSymbolTable.lookupByShortName` for each distinct contract member name.
  The language's deriver keeps its own files (`isEcmascriptSourcePath`,
  `isPythonSourcePath`), because trajectory cannot map a path to a language
  without the tree-sitter-loading extractor. Owner = `scope.at(-1)`. The kernel
  extends direct members to nominal descendants.
- **Rows.** Structural rows are kept apart from `inheritanceRowsByFamily`, so
  pass-2 persistence and the `inheritanceRows` diagnostic stay nominal. They go
  into the per-family `MapHierarchyView` only.
- **MRO.** `NOMINAL_INHERITANCE_KINDS` goes into contracts.
  `ConeDispatchResolver#nearestDefiner` asks for nominal kinds only. The other
  consumers (`interfaceReceiverExcludesCandidate`, `ts-receiver-member-evidence`
  descendant check, the Ruby unbound check, self-dispatch with explicit kinds)
  either want downward dispatch or never see a structural row.

## Tasks (TDD each)

1. Contracts: `InheritanceKind` + `"structural"`, `NOMINAL_INHERITANCE_KINDS`,
   `StructuralContractDecl`, `FileExtraction.structuralContracts`, pass-1 slice
   field, merge rulebook row, `MRO_RANK.structural = 4`.
2. Kernel `structural-conformance.ts`: `deriveStructuralConformance` + unit
   tests (arity, closure, inherited owner members, exclusions, determinism).
3. TS walker: contract extraction (interfaces + object type aliases) and `arity`
   on method/function chunks. Tests.
4. Python walker: Protocol classes → contracts. Tests.
5. Trajectory: registry `hydrate` entry, absorb/hydrate/reset, barrier
   derivation, capability collection. Tests on `CodegraphRunState#seal`.
6. Cone: `nearestDefiner` nominal only. Resolver tests: interface / Protocol
   receiver reaches the structural implementer.
7. Versions re-pin/bump, `gen:lang-compat`, tsc, targeted suites.
8. Offline A/B with the ECMAScript resolve snapshot harness.
