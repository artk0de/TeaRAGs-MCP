# Ruby Comment Capture Design

## Problem

Two places where comments are lost during Ruby chunking:

1. **Method chunks miss preceding comments.** `code.substring(node.startIndex, node.endIndex)` extracts only `def...end`. Comments before the method are tree-sitter sibling nodes outside this range. They fall into body lines instead.

2. **Body grouper drops comments between groups.** `classifyLine("#comment")` returns `undefined`, so comments go to `pendingBlanks`. When group type changes, `flushGroup()` discards `pendingBlanks` — comments are lost.

## Design

### Fix 1: Capture preceding comments in method chunks

**Where:** `tree-sitter-chunker.ts`, method extraction loop (lines 301-338).

**Algorithm:** After finding each method node, scan lines backwards from `childNode.startPosition.row - 1`:
1. Allow up to 1 blank line between comment block and `def`
2. Collect consecutive comment lines (`/^\s*#/`) going upward
3. Prepend collected comments to method chunk content
4. Adjust `startLine` to first comment line
5. Add comment rows to `methodLines` set so `extractContainerBodyLines` excludes them

**Constraints:**
- Ruby only (scope limited per user request)
- 0-1 blank lines tolerated between comment and `def`
- Stops at first non-comment, non-blank line

### Fix 2: Attach comments to next group in body grouper

**Where:** `ruby-body-grouper.ts`, `flushGroup()` and undefined-line handling.

**Algorithm:** When `flushGroup()` is called due to type change, preserve non-blank pending lines (comments) instead of discarding. Prepend them to the next group.

**Implementation:**
- `flushGroup()` returns non-blank pending lines to caller instead of clearing them
- After starting a new group, prepend saved comments to `currentLines`
- At end of loop, trailing comments attach to last group (existing behavior from recent fix)

## Affected Files

- `src/code/chunker/tree-sitter-chunker.ts` — method extraction + methodLines
- `src/code/chunker/ruby-body-grouper.ts` — flushGroup pending logic
- `tests/code/chunker/tree-sitter-chunker.test.ts` — new tests for comment capture
- `tests/code/chunker/ruby-body-grouper.test.ts` — new tests for comment attachment
