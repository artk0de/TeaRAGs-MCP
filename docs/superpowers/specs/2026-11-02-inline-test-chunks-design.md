# Inline test chunks — design

Date: 2026-11-02. Status: approved (approach A).

## Problem

Some languages declare tests inside production source files. tea-rags decides
test-ness per FILE (`classify(relPath).isTest` → `payload.isTest`), so inline
tests are indexed as production code:

- Rust `#[cfg(test)] mod tests { … }` in `src/lib.rs` is already shaped into
  `test` / `test_setup` chunks by `rustTestScopeChunkerHook`, but the chunks
  carry no `isTest`. The `production` filter preset (`isTest must_not`) keeps
  them, `testFile: "only"` cannot find them, and collection stats count them.
- The codegraph invariant "tests are unconditionally out of the graph" holds
  per file only. The Rust walker walks the whole `lib.rs`, so `tests::it_works`
  becomes a graph symbol and its calls become edges into production functions
  (inflated `fanIn` / `pageRank`, test-only callees never look dead).
- Rust attribute recognition reads source LINES, not AST nodes. A probe over 24
  attribute forms (tree-sitter-rust, current build) found 12 misreads: same-line
  `#[test] fn`, trailing comments, multi-line attributes, `#[cfg(test)] mod`
  on one line, `#[cfg(all(test, …))]`, multi-line `cfg`, inner `#![cfg(test)]`,
  `#[wasm_bindgen_test]` / `#[bench]` / `#[quickcheck]` / `#[proptest]`,
  top-level `#[cfg(test)]` items, and the external `#[cfg(test)] mod tests;`
  body file (`src/**/tests.rs`).
- TS/JS Vitest in-source tests (`if (import.meta.vitest) { … }`) are not
  recognised at all: `testScopeChunkerHook` returns unless `isTestFile(path)`.

## Language survey

| Language        | Inline test mechanism                                      | Decision                         |
| --------------- | ---------------------------------------------------------- | -------------------------------- |
| Rust            | `#[cfg(test)]` items/modules, `#[test]`-family attributes  | in scope                         |
| TypeScript / JS | Vitest in-source `if (import.meta.vitest) { … }`           | in scope                         |
| Go              | none — tests compile only from `*_test.go`                 | already path-classified          |
| Python          | doctest in docstrings, `if __name__ == "__main__"` runners | out of scope (docs, not code)    |
| Ruby            | `if __FILE__ == $0` + minitest                             | out of scope (rare idiom)        |
| Java, Swift, Bash | separate files / targets only                           | nothing to do                    |
| Not supported yet | Zig `test {}`, D `unittest {}`, Odin `@(test)`, OCaml `let%test`, Racket `module+ test` | when the language lands |

## Design

### Recognition: one predicate per language, owned by the language

`domains/language/<lang>/inline-tests.ts` exports
`isInlineTestNode(node, code): boolean` — "this node and its whole subtree exist
only in the test build". Its consumers (the language's chunker hooks and its
codegraph walker) live in the same language directory, so no cross-language
contract is introduced.

**Rust.**

- Attributes are read from sibling `attribute_item` nodes preceding the item
  and from `inner_attribute_item` children of the item's body (`#![cfg(test)]`),
  never from source lines.
- `cfg(P)` is evaluated in three-valued logic with `test = false` and every
  other predicate `unknown`. A node is test-only iff the result is definitely
  `false`: `test`, `all(test, …)` → test-only; `any(test, …)`, `not(test)`,
  `feature = "x"` → not.
- Test-function attributes match by the last path segment: `test` (covers
  `tokio::test`, `async_std::test`, `sqlx::test`, `test_log::test`), `rstest`,
  `test_case`, `bench`, `quickcheck`, `proptest`, `wasm_bindgen_test`. A
  function carrying one is test-only (it compiles only under `--test`).
- An inner `#![cfg(test)]` at the file root makes the whole file test-only.
- Behaviour change: a module WITHOUT `cfg(test)` that merely contains `#[test]`
  functions is no longer a test scope as a whole — its non-test items compile
  into the product. Only its test functions are tests.
- `rust/test-files.ts` adds `**/tests.rs`: the body of `#[cfg(test)] mod tests;`.
  Resolving the `mod tests;` declaration across files was rejected (cost) — a
  production `tests.rs` is rare.

**TypeScript / JavaScript.**

- An `if_statement` whose condition is exactly `import.meta.vitest`, optionally
  compared `!= null` / `!== undefined` / via `typeof … !== "undefined"`. A
  negated condition is not a test block.

### Chunking

- Rust: `rustTestScopeChunkerHook` claims a container by `isInlineTestNode`.
  Top-level test-only items get test chunk types: `#[test]`-family functions →
  `test`, other test-only items (`#[cfg(test)] fn helper`, `impl`) →
  `test_setup`.
- TS/JS: `if_statement` joins the chunkable types; the test-DSL filter admits
  only Vitest in-source `if`s, so other top-level `if`s chunk as before. The
  block is a test-scope root: the `import.meta.vitest` destructuring is setup,
  `describe` / `it` / `test` calls are scopes/examples via the existing scope
  builder. `produceTestScopeChunks` (kernel) is not changed.

### Payload

`StaticPayloadBuilder` sets `isTest = true` when the file is a test by path OR
the chunk's `chunkType` is a test chunk type. `TEST_CHUNK_TYPES` moves to
`contracts` so `explore-ops` and the payload builder read one constant. No new
chunk metadata field: the chunk type already states test-ness.

### Codegraph

- The Rust and TS walkers prune subtrees for which `isInlineTestNode` holds, at
  the shared traversal point, so calls, imports (`use super::*`), bindings and
  declarations inside inline tests are not collected.
- Chunks whose payload is a test chunk are not graph symbols and are stamped
  `codegraph.symbols.chunk.skippedAs = "test"`, keeping "never measured"
  distinguishable from "measured zero".
- Consequence (intended): a function called only from inline tests looks dead,
  exactly as with tests in separate files today.

## Testing

- Recognisers: the 24-form probe table becomes unit tests (Rust); a Vitest
  in-source table (TS/JS) including negated and non-vitest `if`s.
- Chunker: golden tests for a `lib.rs` with an inline module and top-level test
  items, and for a `.ts` with an in-source block.
- Payload: `isTest` on a test chunk in a production file; unchanged for
  production chunks.
- Walkers: no calls / imports collected inside inline tests.
- Navigators (`domains/language`, `trajectory/codegraph`): the invariant wording
  names the contract, never enumerates implementers.

## Cost

`isTest` is chunker-owned static payload: Rust and TS projects need a `--force`
reindex to pick it up. Rust and TS walker versions bump once for the release.
