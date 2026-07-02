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

Per-language call resolver implements `CallResolver` contract
(`contracts/types/codegraph.ts`) + mirror `LanguageSymbolResolver`
(`contracts/types/language.ts`). Both = 5-language seam. Decompose
responsibilities BEHIND facade — never grow god-class, never change contract to
decompose.

## 1. The facade is thin; responsibilities are engines + injected collaborators

Each `CallResolver` method delegates to generic engine in `domains/language/`
parameterised by small per-language interface in `contracts/types/language.ts`:

- resolution chain → `resolveViaChain(SymbolResolutionStrategy[])`
- dispatch fan-out → `resolveDispatchViaComponents(DispatchResolverComponent[])`
  and `ConeDispatchResolver(ConeTypeLocator)`
- external classification → `ExternalCallClassifier(ExternalVocabulary)`

Engine owns language-NEUTRAL structure (chain precedence, first-non-empty
fan-out, null-vs-qualified receiver branch). Injected interface owns language
primitives. This = cone-dispatch precedent — copy it for any new responsibility.
Engines live in `domains/language/`; injected interfaces live beside
`ConeTypeLocator` in `contracts/types/language.ts`.

## 2. No inline disjunction over data constants

Classifier predicate must fold over typed registry of polymorphic sources:

```ts
isExternalBareCall(m) = FRAMEWORKS.some((f) => f.hasExternalMember(m));
```

NOT `A.has(m) || m in B || C.has(m)`. External vocabulary = facet of each
framework module (`RubyFrameworkVocabulary`: `entries` + `runtimeBuiltins` +
`hasExternalMember`, built by `defineFrameworkVocabulary`). Add framework = one
module file + one line in `FRAMEWORKS` array → zero resolver/predicate edits.

## 3. Registry is a typed array, not self-registration

ESM class declaration registers nothing; self-registration needs instantiation
plus central side-effect import barrel — equivalent edit-cost to array but
untyped, stateful, import-order-sensitive. Use typed array — it is house style
(`composeEntries`, factory-not-container rule in `domains-language.md`).

## 4. Refactoring discipline

Extracting responsibility into engine = RELOCATION: behaviour byte-identical,
resolve metric (`byReceiverKind` / `resolveSuccessRate`) must not move, existing
business-logic tests stay green untouched (move OK, rewrite NO). New engines =
new entities → get new red-green unit tests.

## Reference implementation

Ruby = pilot: `resolveDispatchViaComponents` + `ExternalCallClassifier` /
`ExternalVocabulary` + `RubyFrameworkVocabulary` / `FRAMEWORKS` /
`isExternalBareCall` + `RubyExternalVocabulary`. TypeScript (`ts-resolver.ts`,
identical four-method shape with own `receiverTypeIsBuiltin` external vocab) =
next migrator.
