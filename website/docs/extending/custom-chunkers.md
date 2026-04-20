---
title: Custom Chunkers
sidebar_position: 3
---

# Custom Chunkers

How chunking works in TeaRAGs and how to extend it — either by adding a new language, tuning existing AST granularity, or implementing a wholly custom chunker for non-code content.

The default path is **tree-sitter + per-language hooks**. Markdown uses **remark** instead (tree-sitter-markdown has compatibility issues with newer tree-sitter versions). Everything unsupported falls back to **character chunker**.

## Chunker Selection

`TreeSitterChunker#supportsLanguage` picks the chunker per file, based on the file extension → `LANGUAGE_MAP` → `LANGUAGE_DEFINITIONS`:

| Chunker | When used | Granularity |
|---------|-----------|-------------|
| `TreeSitterChunker` | Language has entry in `LANGUAGE_DEFINITIONS` with `chunkableTypes` | AST-aware — functions, classes, methods |
| `MarkdownChunker` | `isDocumentation: true` + `skipTreeSitter: true` (remark-based) | Heading hierarchy |
| `CharacterChunker` | Fallback for everything else | Fixed character windows |

Source: `src/core/domains/ingest/pipeline/chunker/config.ts` (`LANGUAGE_DEFINITIONS`, `LANGUAGE_MAP`).

## The `LanguageDefinition` Contract

```ts
interface LanguageDefinition {
  /** Lazy-load the tree-sitter grammar module */
  loadModule: () => Promise<TreeSitterLanguageModule | null>;
  /** Extract the language object from the module (some grammars are nested) */
  extractLanguage?: (mod: TreeSitterLanguageModule) => unknown;
  /** AST node types that should become chunks */
  chunkableTypes: string[];
  /** If a chunkable node exceeds maxChunkSize, recurse into these child types */
  childChunkTypes?: string[];
  /** Always extract children from containers regardless of size (Ruby-style) */
  alwaysExtractChildren?: boolean;
  /** Mark the language as documentation (filters out of "code" search) */
  isDocumentation?: boolean;
  /** Per-language chunking hooks — composable logic attached to AST walk */
  hooks?: ChunkingHook[];
  /** Custom name extraction for unusual nodes (e.g. RSpec `describe` call expressions) */
  nameExtractor?: (node: Parser.SyntaxNode, code: string) => string | undefined;
}
```

Shipping languages (excerpt): TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, Bash, Markdown. Plus `LANGUAGE_MAP` extension-to-language bindings for ~30 extensions total.

## Adding a New Language

Minimum viable entry — add Haskell:

```ts
// src/core/domains/ingest/pipeline/chunker/config.ts

export const LANGUAGE_DEFINITIONS: Record<string, LanguageDefinition> = {
  // ... existing entries ...
  haskell: {
    loadModule: async () =>
      import("tree-sitter-haskell") as Promise<TreeSitterLanguageModule>,
    extractLanguage: (mod) => mod.default ?? mod,
    chunkableTypes: ["signature", "function", "data_type", "newtype", "class_declaration"],
  },
};

// map .hs files to haskell
export const LANGUAGE_MAP: Record<string, string> = {
  // ... existing entries ...
  ".hs": "haskell",
};
```

Steps:

1. `npm install tree-sitter-haskell` (or use an existing grammar)
2. Add the `LANGUAGE_DEFINITIONS` entry — pick `chunkableTypes` by inspecting the grammar's node names (tree-sitter playground or `npx tree-sitter parse`)
3. Add the extension mapping to `LANGUAGE_MAP`
4. Add tests under `tests/core/domains/ingest/pipeline/chunker/` with fixture files
5. Run `npm run build && npm test`

That's it for the simplest case. The language inherits all default behaviour: chunks by node type, falls back to character chunking for content outside chunkable nodes.

## When You Need More: Hooks

Some languages have chunking problems that can't be solved by picking node types. Two built-in examples:

### TypeScript hooks — why two

Located in `src/core/domains/ingest/pipeline/chunker/hooks/typescript/`:

- `comment-capture.ts` — marks comment row ranges as `excludedRows` in the hook context, so they don't get double-counted by subsequent chunkers.
- `class-body-chunker.ts` — reads `excludedRows` (set by comment-capture) and chunks method bodies.

Order matters: comment-capture runs first, body-chunker second. Both register in `typescriptHooks` array and are applied by the chunker in order.

### Ruby hooks — why four

Located in `src/core/domains/ingest/pipeline/chunker/hooks/ruby/`:

- `comment-capture.ts` — same role as TypeScript's
- `class-body-chunker.ts` — handles class bodies that aren't pure method definitions (Rails DSL: `belongs_to`, `validates`, `has_many`)
- `rspec-filter.ts` — filters `call` nodes to only include RSpec DSL (`describe`, `context`, `it`)
- `rspec-scope-chunker.ts` — groups `describe` blocks as first-class chunks with the matcher string in the name

Together with `alwaysExtractChildren: true` (methods ALWAYS extracted from class containers, even small ones), these hooks adapt tree-sitter-ruby output to the actual structure of Rails codebases.

### The `ChunkingHook` interface

```ts
interface ChunkingHook {
  name: string;
  process: (ctx: HookContext) => void;
  /** Filter candidate nodes during chunkable/child node discovery */
  filterNode?: (
    node: Parser.SyntaxNode,
    code: string,
    filePath: string,
  ) => boolean | undefined;
}
```

Two extension points:

- **`process(ctx)`** — mutates the hook context: append chunks, mark row ranges, adjust metadata. Runs once per file after AST walk.
- **`filterNode(node, code, filePath)`** — called per candidate node during AST traversal. Return `true` to include, `false` to exclude, `undefined` to defer.

Keep hooks **narrow and named** (`rspec-filter`, not `rubyExtras`). One hook, one concern. Compose via the `hooks: ChunkingHook[]` array in the language definition.

## Adding a Hook to an Existing Language

Say Python codebases need pytest fixture chunks elevated:

1. Create `src/core/domains/ingest/pipeline/chunker/hooks/python/pytest-fixtures.ts` implementing `ChunkingHook`
2. Barrel-export from `src/core/domains/ingest/pipeline/chunker/hooks/python/index.ts` as `pythonHooks: ChunkingHook[]`
3. Wire into the language definition:

```ts
python: {
  loadModule: async () => import("tree-sitter-python") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod) => mod.default ?? mod,
  chunkableTypes: ["function_definition", "class_definition", "decorated_definition"],
  hooks: pythonHooks, // ← new
},
```

Hooks should be **additive**. If your hook breaks existing chunking for a common pattern, rethink — there's likely a narrower extension point.

## Custom Chunker (Not via Tree-sitter)

If you need a non-AST chunker — e.g. for a binary format, a DSL with a dedicated parser, or specialized logic — implement `BaseChunker` directly. Follow the `MarkdownChunker` template (uses remark instead of tree-sitter):

```ts
// src/core/domains/ingest/pipeline/chunker/hooks/myformat/chunker.ts
export class MyFormatChunker extends BaseChunker {
  supportsLanguage(lang: string): boolean {
    return lang === "myformat";
  }

  async chunk(input: ChunkInput): Promise<Chunk[]> {
    const ast = myParser(input.content);
    return this.walkAst(ast);
  }
}
```

Register in `TreeSitterChunker#supportsLanguage` dispatch (currently a switch; see `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`). Add `skipTreeSitter: true` in the language definition so the tree-sitter path is bypassed.

## Naming Conventions

Match what's in the codebase — future contributors (including the grep they'll run) will be happier:

- Hook file = concern name (`rspec-filter.ts`, not `rubyFilters.ts`)
- One class/function per file
- Barrel re-export from `hooks/{language}/index.ts`
- Arrays named `{language}Hooks` (e.g. `rubyHooks`, `typescriptHooks`)

## Testing

Chunker tests use vitest. Mock tree-sitter in tests that don't exercise real parsing; use real grammars for integration tests.

Place tests next to existing patterns:

- Unit tests per hook: `tests/core/domains/ingest/pipeline/chunker/hooks/{language}/{hook}.test.ts`
- Integration tests with fixture files: `tests/core/domains/ingest/pipeline/chunker/{language}.test.ts`

See `tests/vitest.setup.ts` for required env vars (`MAX_TOTAL_CHUNKS`, `CHUNKER_POOL_SIZE`).

## Don't Break the Contract

Every chunk must carry:

- Non-empty `content`
- Valid `startLine` / `endLine` (inclusive, matching what's inside `content`)
- Metadata from `LanguageDefinition` propagated through (language, chunkType, symbolId if nameable)

[`StaticPayloadBuilder`](/architecture/data-model#base--always-present) consumes these to build the base payload. Breaking the contract at chunking time means broken payloads, broken searches, broken git enrichment.

## Where Code Lives

| Concern | Source |
|---------|--------|
| Language definitions (registry) | `src/core/domains/ingest/pipeline/chunker/config.ts` |
| Tree-sitter chunker (default) | `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` |
| Markdown chunker (remark-based) | `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts` |
| Character chunker (fallback) | `src/core/domains/ingest/pipeline/chunker/character.ts` |
| Hook interface | `src/core/domains/ingest/pipeline/chunker/hooks/types.ts` |
| TypeScript hooks | `src/core/domains/ingest/pipeline/chunker/hooks/typescript/` |
| Ruby hooks | `src/core/domains/ingest/pipeline/chunker/hooks/ruby/` |

## Related

- [Data Model](/architecture/data-model) — what chunking produces as payload
- [Indexing Pipeline](/architecture/indexing-pipeline) — where chunking sits in the pipeline
- [Code Vectorization](/introduction/core-concepts/code-vectorization) — user-facing explanation of chunk granularity choices
- [RFC 0005: Trajectory Enrichment Evolution](/rfc/0005-trajectory-enrichment-evolution) — Ruby DSL chunking problems solved via hooks
