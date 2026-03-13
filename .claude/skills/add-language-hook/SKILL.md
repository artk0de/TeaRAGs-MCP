---
name: add-language-hook
description: Add a new language-specific chunking hook to the ingest pipeline
---

# Add Language Hook

Add a chunking hook for a new or existing language in the ingest pipeline.

Hooks live in `src/core/domains/ingest/pipeline/chunker/hooks/<language>/`.

## Step 1: Check if the language directory exists

Look in `chunker/hooks/` for an existing `<language>/` directory.

- **Exists** — you're adding a new hook to an existing language. Read
  `<language>/index.ts` to see the current hook chain.
- **Doesn't exist** — you're adding hooks for a new language. Create
  `<language>/` directory.

## Step 2: Understand the hook interface

Read `chunker/hooks/types.ts`. Every hook implements:

```typescript
interface ChunkingHook {
  name: string;
  process: (ctx: HookContext) => void;
}
```

`HookContext` provides:

- **Read-only**: `containerNode`, `validChildren`, `code`, `codeLines`, `config`
- **Mutable**: `excludedRows`, `methodPrefixes`, `methodStartLines`,
  `bodyChunks`

Hooks mutate the context in order. Earlier hooks populate state that later hooks
read (e.g., comment-capture populates `excludedRows`, body-chunker reads it).

## Step 3: Create the hook file

Create `hooks/<language>/<hook-name>.ts`. Follow existing patterns:

- `comment-capture.ts` — extracts doc comments, marks rows as excluded
- `class-body-chunker.ts` — splits large class bodies into method-level chunks

Name the exported hook: `<language><Purpose>Hook` (e.g.,
`rubyCommentCaptureHook`, `typescriptBodyChunkingHook`).

## Step 4: Create or update the barrel

`hooks/<language>/index.ts` exports the ordered hook array:

```typescript
import type { ChunkingHook } from "../types.js";
import { myCommentCaptureHook } from "./comment-capture.js";
import { myBodyChunkingHook } from "./class-body-chunker.js";

export const <language>Hooks: ChunkingHook[] = [
  myCommentCaptureHook,   // Order matters: comment-capture first
  myBodyChunkingHook,     // Body chunker reads excludedRows
];
```

## Step 5: Register in language config

Edit `chunker/config.ts`. Find the language entry in `LANGUAGE_DEFINITIONS` and
add the `hooks` property:

```typescript
import { <language>Hooks } from "./hooks/<language>/index.js";

// In LANGUAGE_DEFINITIONS:
<language>: {
  // ... existing config ...
  hooks: <language>Hooks,
},
```

If the language doesn't exist in `LANGUAGE_DEFINITIONS`, add the full entry with
`loadModule`, `extractLanguage`, `chunkableTypes`, and `hooks`.

## Step 6: Write tests

Tests go in `tests/core/domains/ingest/pipeline/chunker/hooks/<language>/`.
Follow existing test patterns in `typescript/` or `ruby/` directories.

Each hook should have its own test file testing the `process()` function with a
real `HookContext` (use `createHookContext()` from `types.ts`).

## Step 7: Verify

```bash
npx tsc --noEmit
npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/<language>/
```
