# Structural conformance in the CHA cone (bd 39xca.14, option D)

Status: approved by the owner 2026-09-26. Bead: tea-rags-mcp-39xca.14.

## Problem

Since hwwtw (`4a74db45f`), a member call on a receiver the checker types as a
project interface is dispatched through the CHA cone: the interface is handed to
the cone as the base type and `hierarchy.getDescendants` reaches its
implementers. The hierarchy holds only NOMINAL rows (`extends`, `implements`)
recorded by the walker. A class or object-literal factory that satisfies an
interface without an `implements` clause is invisible, so its dispatch edges are
lost. Agent B's probe on the tea-rags self corpus found 59 affected call sites.
Among the true targets are `TrajectoryRegistry#buildMergedFilter`,
`CollectionRegistry#findBy*`, `GitCommitDiscovery`,
`createDeletionOutcome.isFullSuccess` and `buildSelfDispatchProbe.*`.

The same defect exists wherever the cone runs over a structural type system:
Python `typing.Protocol` (PEP 544) receivers dispatch to nominal subclasses
only.

## Owner decisions

- Option D: structural implementers become hierarchy members, not a
  resolution-time exception.
- Mechanism is language-neutral (kernel), languages plug in contracts. Today:
  TypeScript and Python. Ruby has no declared structural types until RBS lands;
  Go has no cone yet and plugs in when it gets one.
- RECALL over precision: the agent benefits from seeing call candidates. No
  minimum member count; arity compatibility stays because it barely costs
  recall.
- Flow evidence (a site where a value of `O` enters a slot typed `I`) is a later
  confidence upgrade, not a filter.

## Design

### 1. Contracts (per language, walker, pass-1)

`FileExtraction.structuralContracts?: StructuralContractDecl[]`:

```ts
interface StructuralContractDecl {
  name: string; // fq name as the hierarchy keys it
  members: { name: string; params: number }[]; // required members only
}
```

- TypeScript: every `interface` and every `type X = { ... }` object type.
  Members are method signatures and function-typed property signatures that are
  NOT optional (`?`). Data properties, index and call signatures are excluded:
  the symbol table carries no field definitions, so they cannot be checked.
  `params` = the member's parameter count.
- Python: a class whose bases include `Protocol` (`typing.Protocol`,
  `typing_extensions.Protocol`). Members are its methods minus `self`/`cls`.
  `params` = positional parameter count.
- Per-file fact: stored in pass-1 aggregates and hydrated for walked languages
  under the same `hydrate` policy as `inheritanceRows`
  (`run-global-map-registry.ts`), so an incremental run sees every file's
  contracts.
- The TypeScript walker starts emitting `arity` (`AritySignature`) for methods
  and functions; Python already does.

### 2. Conformance derivation (kernel, barrier)

`kernel/structural-conformance.ts`, a pure function:

- Inputs: the family's contracts; an owner index built from the symbol table,
  `owner → memberName → AritySignature[]`, extended with methods of the owner's
  NOMINAL ancestors; the family's nominal inheritance rows.
- Contract closure: `R(I) = own members ∪ R(J)` for every `I extends J` in the
  nominal rows (interface heritage is recorded as `implements`).
- Rule: owner `O` conforms to `I` when, for every `r ∈ R(I)`, `O` has a member
  named `r.name` with `minRequired ≤ r.params` (an implementation may accept
  fewer parameters than declared, never require more). A member with no recorded
  arity matches by name. `R(I)` empty → no conformers.
- Excluded owners: contracts themselves, owners that already nominally descend
  from `I` (the row already exists), owners with no methods.
- Output: `InheritanceEdgeRow` with `kind: "structural"`, appended to the
  family's rows BEFORE `buildHierarchyViewsPerFamily`.
- Deterministic: sorted by (contract, owner). Cost: index `memberName → owners`,
  intersect starting from the rarest member of the contract; never contracts ×
  owners.
- Mode independence: both inputs are complete in full and incremental runs.

### 3. Contract and type changes

- `InheritanceKind` gains `"structural"`.
- `MapHierarchyView` `MRO_RANK`: `structural` ranks below `implements`.
- Ancestor linearization / `super` / member lookup up the MRO use NOMINAL kinds
  only; a structural ancestor contributes downward dispatch, never inherited
  implementation.
- Structural rows are NOT persisted to `cg_symbols_inheritance`: they are
  derived, recomputed every barrier. No migration.

### 4. Consumers

- TS `interfaceReceiverExcludesCandidate` and the cone see structural
  implementers through `getDescendants` unchanged.
- Python cone locator: a receiver typed as a Protocol reaches its structural
  implementers the same way.
- Fan-out stays governed by `kernel/dispatch-narrowing.ts`: one survivor →
  `confidence 1.0`, a fan → `discount/m`, over the cap → `ambiguous`.

### 5. Versions

- `typescript.walker`, `python.walker`: already bumped this release cycle →
  re-pin only (`npm run pin:lang-versions`).
- `sharedVersions.walker`: the kernel changes resolution output; bump unless
  already bumped this cycle, else re-pin.
- `codegraphSchema`: unchanged — nothing new is persisted.

## Testing

- Kernel: coverage of the contract, arity compatibility, inherited contract
  members (`I extends J`), owner members inherited from nominal ancestors,
  deterministic order, exclusions.
- Walkers: TS contract + arity extraction, Python Protocol extraction,
  materialized-vs-native parity for the new channels.
- Resolvers: a call on an interface / Protocol receiver reaches the structural
  implementer; nominal edges unchanged.
- Offline A/B on tea-rags (`ecmascript-resolve-snapshot` before/after): how many
  of agent B's 59 sites gain edges; zero change to nominal edges.

## Live validation (after the merge to main, with the batch)

`DEBUG=1 node build/cli/index.js index-codebase --project tea-rags --force-enrichments codegraph --languages typescript,python --json`,
then `prime` resolve rates and a `get_callers` probe on
`TrajectoryRegistry#buildMergedFilter`.
