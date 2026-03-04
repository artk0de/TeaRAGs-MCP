# Design: MarkdownChunker — Improved Markdown Chunking Quality

**Date**: 2026-03-04
**Status**: Approved

## Problem

The current markdown chunking in `chunkMarkdownSimple()` (tree-sitter.ts:462-654) produces low-quality chunks:

1. **Frontmatter pollution** — YAML frontmatter (`---\ntitle: ...\n---`) is parsed as paragraphs, creating noise chunks like `name: "title: \"RFC 0003\"..."` that contaminate search
2. **Micro code block chunks** — Every fenced code block ≥30 chars becomes a separate chunk. Result: `project-level-setup.md` produces 28 chunks (11 sections + 17 code blocks), many just 1-3 lines
3. **No context for code blocks** — Code block chunks have `name: "Code block"` or `name: "Code: bash"` with no reference to their parent section
4. **Mermaid diagram noise** — Mermaid syntax (`A <-->|...|B`) inside `<MermaidTeaRAGs>` components becomes code chunks with `language: "code"`

## Approach

Extract markdown chunking into a dedicated `MarkdownChunker` class in `chunker/hooks/markdown/`, applying all 4 fixes.

### Alternatives Considered

- **A: Incremental patches** — 4 fixes inside existing `chunkMarkdownSimple()`. Simpler but further bloats a 200-line method.
- **C: Remove code block chunks entirely** — Simplest but loses ability to search code examples by language.

## Architecture

```
src/core/ingest/pipeline/chunker/
  hooks/
    markdown/
      chunker.ts          ← MarkdownChunker class (new)
      index.ts            ← barrel export (new)
  tree-sitter.ts          ← delegates to MarkdownChunker (removes chunkMarkdownSimple)
```

`MarkdownChunker` is a standalone class with a single public method:
```typescript
class MarkdownChunker {
  constructor(config: { maxChunkSize: number }, fallbackChunker: Chunker);
  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]>;
}
```

`TreeSitterChunker` delegates to it instead of `chunkMarkdownSimple()`.

### New dependency

`remark-frontmatter` (npm install) — already used in website/, now needed in main project.

## Fix Details

### Fix 1: Frontmatter Handling

```typescript
remark().use(remarkGfm).use(remarkFrontmatter, ['yaml']).parse(code);
```

Frontmatter nodes (type `"yaml"`) are ignored during AST traversal. Preamble content starts after frontmatter.

### Fix 2: Code Block Deduplication

**Current behavior**: Code blocks exist both inside section chunks AND as separate chunks (duplication).

**New behavior**: Code blocks are excluded from section content. Sections contain only prose text. Code blocks ≥50 chars (raised from 30) become separate chunks with `parentName`.

Implementation: When building section content, skip lines that belong to any code block within that section. This removes the code from the section chunk while preserving surrounding prose.

### Fix 3: parentName for Code Blocks

When creating a code block chunk, find the nearest h1/h2 heading by comparing `startLine`:

```typescript
parentName: nearestHeading?.text,
parentType: `h${nearestHeading?.depth}`,
```

This enables navigating from a code example back to its documentation context.

### Fix 4: Mermaid/Diagram Filter

Skip code blocks where:
- `lang === "mermaid"` (explicit Mermaid)
- No `lang` and content matches Mermaid heuristic: contains `-->` or `---` combined with `subgraph` or `flowchart` or `graph`

These are visual artifacts, not searchable code.

## Trade-offs

| Decision | Gain | Loss |
|----------|------|------|
| Exclude code from sections | Zero duplication, smaller chunks | Section loses inline code context |
| Raise min code block to 50 chars | Fewer noise chunks | Might skip some valid tiny snippets |
| Mermaid heuristic (no-lang blocks) | Fewer diagram noise chunks | Possible false positives on `-->` in non-Mermaid |
| parentName on code blocks | Navigability from code to docs | Slight complexity in position lookup |

## Affected Files

| File | Change |
|------|--------|
| `package.json` | + `remark-frontmatter` dependency |
| `chunker/hooks/markdown/chunker.ts` | **NEW** — MarkdownChunker class |
| `chunker/hooks/markdown/index.ts` | **NEW** — barrel export |
| `chunker/tree-sitter.ts` | Remove `chunkMarkdownSimple()`, delegate to MarkdownChunker |
| `tests/.../tree-sitter-chunker.test.ts` | Remove markdown tests (moved) |
| `tests/.../hooks/markdown/chunker.test.ts` | **NEW** — tests for all 4 fixes |

## Testing Strategy

- Migrate all existing markdown tests from `tree-sitter-chunker.test.ts`
- Add tests for: frontmatter stripping, code block dedup, parentName resolution, Mermaid filtering
- Integration: re-index project, compare chunk count and quality before/after
