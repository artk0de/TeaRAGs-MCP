---
title: "RFC 0005: AST Chunking Evolution"
sidebar_position: 5
slug: /rfc/0005-trajectory-enrichment-evolution
---

# RFC 0005: AST Chunking Evolution

## Status

Implemented

## Context

The tree-sitter-based chunker produces semantically meaningful code chunks for embedding. However, several language-specific patterns -- particularly in Ruby/Rails codebases -- exposed structural weaknesses that degraded search quality. This RFC documents the iterative evolution of the chunking system to address four distinct problems.

## Problem 1: Monster Class Body Chunks

### Symptom

Ruby class bodies produce a single oversized chunk containing all DSL declarations (associations, validations, scopes, callbacks). A typical Rails model class body spans 80--200 lines of mixed declaration types, exceeding useful embedding granularity and diluting semantic signal.

### Root Cause

The `alwaysExtractChildren` strategy extracts method nodes individually but collapses everything else into one "body" chunk. This works for languages where class bodies are primarily method definitions, but fails for Ruby/Rails models where 70--80% of the class body is declarative DSL.

### Solution: RubyBodyGrouper

A new module (`ruby-body-grouper.ts`) classifies each line of a class body by its declaration type using a keyword lookup table:

| Group | Keywords |
|-------|----------|
| `associations` | `has_many`, `has_one`, `belongs_to`, `has_and_belongs_to_many` |
| `validations` | `validates`, `validate`, `validates_with`, `validates_*_of` |
| `scopes` | `scope` |
| `callbacks` | `before_save`, `after_create`, `after_commit`, etc. |
| `includes` | `include`, `extend`, `prepend` |
| `attributes` | `attr_accessor`, `attr_reader`, `attribute`, `has_one_attached` |
| `enums` | `enum` |
| `delegates` | `delegate`, `delegate_missing_to` |
| `state_machine` | `aasm` |
| `other` | Unrecognized identifiers |

Adjacent lines of the same type merge into a single group. When the type changes, a new group starts. Each group becomes an independent chunk with the class header prepended for context:

```text
Before:  1 body chunk (180 lines, mixed declarations)
After:   7 body chunks (includes, associations, enums, validations, callbacks, scopes, delegates)
```

Groups exceeding `maxChunkSize` split at line boundaries, preserving the type label across sub-chunks.

## Problem 2: Lost Comments Before Methods

### Symptom

Comments immediately preceding a `def` keyword are not included in the method chunk. `code.substring(node.startIndex, node.endIndex)` captures only the tree-sitter node range, which starts at `def`. Comments are sibling nodes that fall outside this range and get absorbed into the body chunk or dropped entirely.

### Solution: Backward Comment Scan

After locating each method node, the chunker scans lines backward from `node.startPosition.row - 1`:

1. Allow up to 1 blank line between the comment block and `def`.
2. Collect consecutive comment lines (`/^\s*#/`) moving upward.
3. Prepend collected comments to the method chunk content.
4. Adjust `startLine` to the first comment line.
5. Add comment rows to the `methodLines` set so `extractContainerBodyLines` excludes them from the body.

This is scoped to Ruby only. The tolerance of 0--1 blank lines between comment and `def` matches standard Ruby style conventions.

## Problem 3: Block Artifacts from `do...end`

### Symptom

Multiline `do...end` blocks in scopes, callbacks, and DSL methods produce two pathological artifacts:

1. **Orphaned `end` keywords.** `classifyLine("end")` returns `"other"`, creating degenerate single-line groups. With the class header prepended, these become 55+ character chunks like `"class Pipeline::StageClient < ApplicationRecord\nend"` that pass the minimum size filter and pollute search results.

2. **Lost block bodies.** Lines inside `do...end` blocks are continuation lines (`classifyLine` returns `undefined`), so they go to `pendingBlanks` and get discarded on group type change. A scope like `scope :affected_by_time_entry, ->(time_entry) do` retains only the declaration line; the `joins`, `where`, and `distinct` calls inside the block are lost.

3. **Fragmented concern hooks.** `included do...end` blocks are not recognized, causing their contents to scatter across multiple chunks. Nested blocks like `aasm do...end` inside `included` are lost entirely.

### Solution: Block-Depth Tracking

The `RubyBodyGrouper.groupLines()` method tracks two depth counters:

- **`blockDepth`** for `do...end` pairs (regex: `/\bdo\s*(\|[^|]*\|)?\s*(#.*)?$/`)
- **`braceDepth`** for `{ }` pairs (cumulative open/close balance per line)

When depth is greater than zero, all lines are treated as continuations of the current group, regardless of their keyword classification. When depth returns to zero, the accumulated lines are absorbed into the current group.

An exception list prevents certain keywords from incrementing depth:

```typescript
const BLOCK_DEPTH_EXCEPTIONS = new Set([
  "included",      // included do...end -> flat body
  "extended",      // extended do...end -> flat body
  "class_methods", // class_methods do...end -> flat body
]);
```

These concern-level blocks are treated as transparent wrappers: their contents are classified normally as if the `do...end` were not present.

### Result

| Metric | Before | After |
|--------|--------|-------|
| `Pipeline::StageClient` artifact chunks | 7 | 0 |
| Scope chunks with complete body | partial | full (joins, where, distinct) |
| AASM state machine | fragmented across 3+ chunks | single semantic chunk |
| Concern hooks (`included`/`extended`) | contents scattered | transparent, contents grouped normally |

## Problem 4: Git Enrichment Includes Ignored Paths

### Symptom

The git log prefetch reads the full repository history. Paths matching `.gitignore` or `.contextignore` appear in the git metadata map but have no corresponding chunks in the vector store. This inflates the map size and produces misleading path-mismatch diagnostics.

### Solution: Pass Ignore Filter to Enrichment

The `FileScanner` already maintains an `Ignore` instance for file discovery. This instance is now exposed via `getIgnoreFilter()` and passed to `EnrichmentModule.prefetchGitLog()`. After the git log map is built, entries matching the ignore filter are removed:

```typescript
prefetchGitLog(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
  // ... after buildFileMetadataMap resolves:
  if (this.ignoreFilter) {
    for (const [path] of result) {
      if (this.ignoreFilter.ignores(path)) {
        result.delete(path);
      }
    }
  }
}
```

Files affected: `scanner.ts` (expose filter), `enrichment-module.ts` (accept and apply filter), `indexing-module.ts` and `reindex-module.ts` (pass filter through).

## Design Principles

These four changes follow consistent architectural principles:

1. **Language hooks, not conditionals.** Ruby-specific logic lives in dedicated modules (`ruby-body-grouper.ts`) composed via configuration, not `if (language === "ruby")` branches in the main chunker. The main chunker delegates to the grouper when the language config activates it.

2. **Preserve existing contracts.** No public API changes. `WorkerPool`, `BatchAccumulator`, `QdrantManager`, and `CodeIndexer` are untouched. The improvements are internal to the chunking and enrichment pipeline.

3. **Test-driven development.** Each problem was addressed by writing failing tests first (grouper unit tests, chunker integration tests, enrichment filter tests), then implementing the fix to make them pass.

4. **Incremental delivery.** Each fix was implemented and committed independently, allowing isolated review and rollback.
