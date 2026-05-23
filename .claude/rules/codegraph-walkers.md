---
paths:
  - "src/core/domains/ingest/pipeline/chunker/extraction/**"
  - "src/core/domains/trajectory/codegraph/symbols/resolvers/**"
  - "src/core/domains/trajectory/codegraph/symbols/provider.ts"
  - "tests/core/domains/ingest/pipeline/chunker/extraction/**"
  - "tests/core/domains/trajectory/codegraph/symbols/resolvers/**"
---

# Codegraph Walkers — Per-Language Contract

A "walker" is a pure function that consumes a tree-sitter `Tree` for one file in
a target language and returns a `FileExtraction`. Walkers live at
`src/core/domains/ingest/pipeline/chunker/extraction/<lang>-walker.ts`. A
companion **resolver** translates extracted imports + call receivers into graph
edges; it lives at
`src/core/domains/trajectory/codegraph/symbols/resolvers/<lang>/`.

## When you add a new language

Every language whose tree-sitter parser is declared in `package.json` MUST have
a walker + resolver wired through the codegraph provider. Partial coverage is
worse than none — composite presets that weight `fanIn` / `fanOut` silently
degrade to similarity-only on unsupported languages, and agents querying
multi-language repos see misleading ranking overlays without any signal that the
data is missing.

Required pieces, in order:

1. **`<lang>-walker.ts`** under `extraction/`. Exports
   `extractFrom<Lang>File(input): FileExtraction`. Same input shape as
   typescript-walker.

2. **`<lang>NameOf(node)`** in `provider.ts` (or local to the walker). Returns
   `{ name, descendsInto }` for top-level symbol declarations; `null` otherwise.

3. **Entry in `LANGUAGES` map** in `provider.ts`:

   ```ts
   ".rb": {
     language: "ruby",
     loadParser: () => RbLang as Parser.Language,
     walker: extractFromRubyFile,
     nameOf: rbNameOf,
     scopeSeparator: "::",
   },
   ```

4. **`resolvers/<lang>/<lang>-resolver.ts`** implementing `CallResolver`.
   Registered in `bootstrap/factory.ts` `resolvers` map with the language string
   matching what the walker emits.

5. **Two test files** (mandatory comprehensive coverage — see below):
   - `tests/core/domains/ingest/pipeline/chunker/extraction/<lang>-walker.test.ts`
   - `tests/core/domains/trajectory/codegraph/symbols/resolvers/<lang>/<lang>-resolver.test.ts`

## Walker output shape

```ts
interface FileExtraction {
  relPath: string;
  language: string; // matches LanguageConfig.language
  imports: ImportRef[];
  chunks: ChunkExtraction[];
  fileScope: string[]; // top-level symbols this file DEFINES
}
```

### `imports[]`

One `ImportRef` per discovered import statement OR per discovered
import-equivalent reference (e.g. Ruby Zeitwerk constant uses). Two shapes:

- **Direct import** — `importText` is the raw module spec (`"foo.bar"`,
  `"./foo"`, `"'foo'"`). Resolver translates to file path via language-specific
  rules (tsconfig paths, Python module layout, etc.).

- **Convention-based** — for languages with implicit imports (Zeitwerk,
  classpath, etc.), use a **prefix marker** so the resolver can distinguish
  channels. Example: ruby-walker uses `zeitwerk:` prefix. Pick a prefix that
  can't appear in a real import path; export the constant from the walker so the
  resolver imports it instead of duplicating the string.

`startLine` is 1-indexed (`node.startPosition.row + 1`).

### `chunks[].calls[]`

One `CallRef` per call expression located within the chunk's
`[startLine, endLine]` line range. Receiver is the resolved expression text
(member access chain like `a.b.c`) or null for bare calls.

### `fileScope[]`

Symbols this file DECLARES at file level. Used by resolvers that need reverse
lookup ("what file defines constant X?"). Ruby uses this for Zeitwerk; Python
doesn't strictly need it (modules ARE files) but walkers should still populate
top-level functions/classes for consistency.

## Two-channel languages

Some languages have BOTH explicit imports AND implicit load-by-convention. Ruby
is the canonical example:

- `require 'foo'`, `require_relative './foo'` — explicit, emit normal ImportRef.
- `User.find` with autoload (Zeitwerk) — implicit, emit ImportRef with a
  convention prefix (`zeitwerk:User`).

Both channels share the imports[] array. The resolver checks the prefix on each
entry to pick the right resolution algorithm.

## Test coverage (mandatory)

Each walker must have tests that exercise:

1. **Every import syntax form in the language** — both common cases and the edge
   cases that bite real code (relative imports, namespace-aware syntax, alias
   forms).
2. **Symbol extraction at every nesting level** — top-level declarations, nested
   classes, methods inside classes. Verify the symbol id composition uses the
   right scope separator.
3. **Call site grouping by chunk** — verify each call falls into the correct
   chunk based on its line number.
4. **Edge cases** — empty file, syntactically broken source, files with only
   comments / docstrings, files with imports but no symbols.

Each resolver must have tests that exercise:

1. **Receiver match** — import receiver matches and the lookup resolves to the
   right file + symbol.
2. **Unresolved-symbol fallback** — import resolves to a file path but the
   symbol table has no matching short-name (resolver records target file with
   `targetSymbolId: null`).
3. **Global short-name fallback** — bare calls without receiver.
4. **Ambiguous global short-name** — multiple matches must return `null`, not
   guess.
5. **Convention-based resolution** (if applicable) — Zeitwerk-style constant →
   file mapping with multiple autoload roots.

Reference layouts: see python-walker tests (17 cases) and ruby-walker tests (23
cases) as the minimum bar.

## Performance + correctness rules

- **Walker is pure.** No I/O, no global state. Same input → same output.
- **One AST walk per file.** Composing multiple `walk(root, visit)` calls is
  fine — each tree pass is cheap.
- **No regex over source code.** Use tree-sitter node types. Regex over
  imports/calls misses comments, strings, and breaks on minor syntactic
  variations. The one exception is value-stripping (e.g. `"foo"` → `foo`), which
  is unambiguous.
- **No throw on partial parse.** Tree-sitter is error-tolerant — walker must be
  too. Tests cover the broken-input case.
- **Tolerant of grammar drift.** When a tree-sitter parser bumps its grammar,
  node-type names sometimes rename (`method_call` ↔ `call`). Walker should
  handle both shapes when known to vary.

## Anti-patterns

- **Hardcoding `.ts` extension** in shared codegraph code. The `LANGUAGES` map
  is the single source of truth — add a row, don't add an
  `if extension === ".rb"` branch.
- **Calling the symbol table from inside the walker.** Walkers don't resolve —
  they extract. Resolution is the resolver's job; walker emits raw `importText`
  and lets the resolver decide.
- **Smuggling resolver knowledge into walker output.** If your walker knows that
  Zeitwerk maps `User` to `app/models/user.rb`, that belongs in
  `resolvers/<lang>/zeitwerk.ts`, not in the walker.
- **One walker that dispatches by content sniffing.** Each language gets its own
  walker file. Cross-language dispatch is at the provider level (`LANGUAGES`
  lookup by extension).
