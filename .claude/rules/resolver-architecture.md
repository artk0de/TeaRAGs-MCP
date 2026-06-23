---
paths:
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/external-classifier.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/language/*/resolver/**"
  - "src/core/domains/language/*/dsl/**"
  - "src/core/contracts/types/language.ts"
  - "tests/core/domains/language/*/resolver/**"
---

# Call Resolver Architecture — How to Write One

A per-language call resolver implements the `CallResolver` contract
(`contracts/types/codegraph.ts`) and its mirror `LanguageSymbolResolver`
(`contracts/types/language.ts`). Both are the 5-language seam. Decompose
responsibilities BEHIND the facade — never grow a god-class, never change the
contract to decompose.

## 1. The facade is thin; responsibilities are engines + injected collaborators

Each `CallResolver` method delegates to a generic engine in `domains/language/`
that is parameterised by a small per-language interface in
`contracts/types/language.ts`:

- resolution chain → `resolveViaChain(SymbolResolutionStrategy[])`
- dispatch fan-out → `resolveDispatchViaComponents(DispatchResolverComponent[])`
  and `ConeDispatchResolver(ConeTypeLocator)`
- external classification → `ExternalCallClassifier(ExternalVocabulary)`

The engine owns the language-NEUTRAL structure (chain precedence,
first-non-empty fan-out, null-vs-qualified receiver branch). The injected
interface owns the language primitives. This is the cone-dispatch precedent —
copy it for any new responsibility. Engines live in `domains/language/`; the
injected interfaces live beside `ConeTypeLocator` in
`contracts/types/language.ts`.

## 2. No inline disjunction over data constants

A classifier predicate must fold over a typed registry of polymorphic sources:

```ts
isExternalBareCall(m) = FRAMEWORKS.some((f) => f.hasExternalMember(m));
```

NOT `A.has(m) || m in B || C.has(m)`. External vocabulary is a facet of each
framework module (`RubyFrameworkVocabulary`: `entries` + `runtimeBuiltins` +
`hasExternalMember`, built by `defineFrameworkVocabulary`). Adding a framework =
one module file + one line in the `FRAMEWORKS` array → zero resolver/predicate
edits.

## 3. Registry is a typed array, not self-registration

ESM class declaration registers nothing; self-registration needs instantiation
plus a central side-effect import barrel that is equivalent in edit-cost to the
array but untyped, stateful, and import-order-sensitive. Use the typed array —
it is the house style (`composeEntries`, the factory-not-container rule in
`domains-language.md`).

## 4. Refactoring discipline

Extracting a responsibility into an engine is RELOCATION: behaviour
byte-identical, the resolve metric (`byReceiverKind` / `resolveSuccessRate`)
must not move, existing business-logic tests stay green untouched (move OK,
rewrite NO). New engines are new entities → they get new red-green unit tests.

## Reference implementation

Ruby is the pilot: `resolveDispatchViaComponents` + `ExternalCallClassifier` /
`ExternalVocabulary` + `RubyFrameworkVocabulary` / `FRAMEWORKS` /
`isExternalBareCall` + `RubyExternalVocabulary`. TypeScript (`ts-resolver.ts`,
identical four-method shape with its own `receiverTypeIsBuiltin` external vocab)
is the next migrator.
