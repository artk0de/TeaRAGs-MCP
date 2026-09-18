---
paths:
  - "src/core/domains/language/*/walker/**"
  - "src/core/domains/language/*/resolver/**"
  - "src/core/domains/trajectory/codegraph/symbols/provider.ts"
  - "src/core/domains/trajectory/codegraph/symbols/file-extractor.ts"
  - "tests/core/domains/language/*/walker/**"
  - "tests/core/domains/language/*/resolver/**"
---

# Codegraph Walkers — Per-Language Contract

"Walker" = pure fn, consumes tree-sitter `Tree` for one file in target language,
returns `FileExtraction`. Lives at
`src/core/domains/language/<lang>/walker/walker.ts`, with its passes as siblings
in the same directory. Companion **resolver** translates extracted imports +
call receivers into graph edges; lives at
`src/core/domains/language/<lang>/resolver/` (entry `<lang>-resolver.ts`, e.g.
`ruby/resolver/ruby-resolver.ts`; TypeScript's is `ts-resolver.ts`).

## When you add a new language

Every language whose tree-sitter parser declared in `package.json` MUST have
walker + resolver wired through codegraph provider. Partial coverage worse than
none — composite presets weighting `fanIn`/`fanOut` silently degrade to
similarity-only on unsupported languages; agents querying multi-language repos
see misleading overlays, no missing-data signal.

Required pieces, in order:

1. **`<lang>/walker/walker.ts`**. Exports
   `extractFrom<Lang>File(input): FileExtraction`. Same input shape as the
   TypeScript walker.

2. **`<lang>NameOf(node)`** in `<lang>/walker/name-of.ts` (`rbNameOf`,
   `goNameOf`, …) — the `LanguageWalker.nameOf` contract in
   `contracts/types/language.ts`: `NamedSymbol | NamedSymbol[]` for a symbol
   declaration, `null` otherwise.

3. **A native `LanguageProvider`** in `<lang>/index.ts` exposing `walker`
   (walk + `nameOf`) and `resolver`, constructed in ONE branch of
   `LanguageFactory#build` (`domains/language/factory.ts`) — see
   `.claude/rules/domains-language.md` rule 1.

4. **Entry in `CODEGRAPH_LANGUAGES`** in
   `domains/trajectory/codegraph/symbols/file-extractor.ts`. The row carries the
   grammar and the scope separator only; the walk and `nameOf` come from
   `factory.create(lang).walker`:

   ```ts
   ".rb": {
     language: "ruby",
     loadParser: () => RbLang as Parser.Language,
     scopeSeparator: "::",
   },
   ```

5. **`<lang>/resolver/<lang>-resolver.ts`** implementing `CallResolver`, handed
   out as the provider's `resolver` with the language string matching what the
   walker emits.

6. **Two test directories** (mandatory comprehensive coverage — see below):
   - `tests/core/domains/language/<lang>/walker/`
   - `tests/core/domains/language/<lang>/resolver/`

## Walker output shape

```ts
interface FileExtraction {
  relPath: string;
  language: string; // matches CodegraphLanguageConfig.language
  imports: ImportRef[];
  chunks: ChunkExtraction[];
  fileScope: string[]; // top-level symbols this file DEFINES
}
```

### `imports[]`

One `ImportRef` per import statement OR import-equivalent reference (e.g. Ruby
Zeitwerk constant uses). Two shapes:

- **Direct import** — `importText` = raw module spec (`"foo.bar"`, `"./foo"`,
  `"'foo'"`). Resolver translates to file path via language rules (tsconfig
  paths, Python module layout, etc.).

- **Convention-based** — for implicit-import languages (Zeitwerk, classpath,
  etc.), use **prefix marker** so resolver distinguishes channels. Example:
  ruby-walker uses `zeitwerk:` prefix. Pick prefix that can't appear in real
  import path. Define it ONCE, in a zero-import leaf module at the language
  root, and have walker and resolver both import it from there — never duplicate
  the string, and never make the resolver import it from the walker (a stable
  resolver hub then depends on the walker orchestrator for a string). Example:
  `ruby/zeitwerk-import-marker.ts` (`ZEITWERK_PREFIX`); the same holds for any
  walker↔resolver marker, e.g. `ruby/super-receiver-sentinel.ts`
  (`SUPER_RECEIVER_SENTINEL`). The walker's entry module may re-export it for
  existing importers.

`startLine` is 1-indexed (`node.startPosition.row + 1`).

### `chunks[].calls[]`

One `CallRef` per call expression within chunk's `[startLine, endLine]` line
range. Receiver = resolved expression text (member access chain `a.b.c`) or null
for bare calls.

### `fileScope[]`

Symbols file DECLARES at file level. Used by resolvers needing reverse lookup
("what file defines constant X?"). Ruby uses for Zeitwerk; Python doesn't
strictly need (modules ARE files) but walkers should still populate top-level
functions/classes for consistency.

## Two-channel languages

Some languages have BOTH explicit imports AND implicit load-by-convention. Ruby
= canonical:

- `require 'foo'`, `require_relative './foo'` — explicit, emit normal ImportRef.
- `User.find` with autoload (Zeitwerk) — implicit, emit ImportRef with
  convention prefix (`zeitwerk:User`).

Both channels share imports[] array. Resolver checks prefix per entry to pick
resolution algorithm.

## Test coverage (mandatory)

Each walker must test:

1. **Every import syntax form in the language** — common + edge cases that bite
   real code (relative imports, namespace-aware syntax, alias forms).
2. **Symbol extraction at every nesting level** — top-level, nested classes,
   methods inside classes. Verify symbol id composition uses right scope
   separator.
3. **Call site grouping by chunk** — each call falls into correct chunk by line
   number.
4. **Edge cases** — empty file, syntactically broken source,
   comments/docstrings-only, imports but no symbols.

Each resolver must test:

1. **Receiver match** — import receiver matches, lookup resolves to right file +
   symbol.
2. **Unresolved-symbol fallback** — import resolves to file path but symbol
   table has no matching short-name (resolver records target file,
   `targetSymbolId: null`).
3. **Global short-name fallback** — bare calls without receiver.
4. **Ambiguous global short-name** — multiple matches return `null`, not guess.
5. **Convention-based resolution** (if applicable) — Zeitwerk-style constant →
   file mapping with multiple autoload roots.

Reference layouts: python-walker tests (17 cases) + ruby-walker tests (23 cases)
= minimum bar.

## Performance + correctness rules

- **Walker is pure.** No I/O, no global state. Same input → same output.
- **One AST walk per file.** Composing multiple `walk(root, visit)` calls fine —
  each tree pass cheap.
- **No regex over source code.** Use tree-sitter node types. Regex over
  imports/calls misses comments, strings, breaks on minor syntactic variations.
  One exception = value-stripping (e.g. `"foo"` → `foo`), unambiguous.
- **No throw on partial parse.** Tree-sitter error-tolerant — walker too. Tests
  cover broken-input case.
- **Tolerant of grammar drift.** When tree-sitter parser bumps grammar,
  node-type names sometimes rename (`method_call` ↔ `call`). Walker handles both
  shapes when known to vary.

## Anti-patterns

- **Hardcoding `.ts` extension** in shared codegraph code. `CODEGRAPH_LANGUAGES`
  = single source of truth — add a row, not an `if extension === ".rb"` branch.
- **Calling symbol table from inside walker.** Walkers extract, don't resolve —
  resolution is resolver's job; walker emits raw `importText`, resolver decides.
- **Smuggling resolver knowledge into walker output.** If walker knows Zeitwerk
  maps `User` to `app/models/user.rb`, that belongs in
  `<lang>/resolver/zeitwerk.ts` (`ruby/resolver/zeitwerk.ts`), not the walker.
- **One walker dispatching by content sniffing.** Each language gets own walker
  file. Cross-language dispatch at provider level (`CODEGRAPH_LANGUAGES` lookup
  by extension).
