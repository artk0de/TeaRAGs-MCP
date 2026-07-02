---
name: add-language-hook
description:
  Add chunker hook splitting a language's source files into searchable chunks
  (classes, functions, comments) in ingest pipeline. Triggers on "add Kotlin
  support", "improve TypeScript class chunking", "fix Ruby comment extraction",
  "add language X". NOT for tweaking generic chunker behavior — edit chunker
  base directly for language-agnostic changes.
---

# Add Language Hook

Add chunking hook for new/existing language in ingest pipeline.

Hooks live in `src/core/domains/ingest/pipeline/chunker/hooks/<language>/`.

## Step 1: Check if the language directory exists

Look in `chunker/hooks/` for existing `<language>/` directory.

- **Exists** — adding new hook to existing language. Read `<language>/index.ts`
  for current hook chain.
- **Doesn't exist** — adding hooks for new language. Create `<language>/`
  directory.

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

Hooks mutate context in order. Earlier hooks populate state later hooks read
(e.g. comment-capture populates `excludedRows`, body-chunker reads it).

## Step 3: Create the hook file

Create `hooks/<language>/<hook-name>.ts`. Follow existing patterns:

- `comment-capture.ts` — extracts doc comments, marks rows excluded
- `class-body-chunker.ts` — splits large class bodies into method-level chunks

Name exported hook: `<language><Purpose>Hook` (e.g. `rubyCommentCaptureHook`,
`typescriptBodyChunkingHook`).

## Step 4: Create or update the barrel

`hooks/<language>/index.ts` exports ordered hook array:

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

Edit `chunker/config.ts`. Find language entry in `LANGUAGE_DEFINITIONS`, add
`hooks` property:

```typescript
import { <language>Hooks } from "./hooks/<language>/index.js";

// In LANGUAGE_DEFINITIONS:
<language>: {
  // ... existing config ...
  hooks: <language>Hooks,
},
```

Language absent from `LANGUAGE_DEFINITIONS` → add full entry with `loadModule`,
`extractLanguage`, `chunkableTypes`, `hooks`.

## Step 6: Write tests

Tests go in `tests/core/domains/ingest/pipeline/chunker/hooks/<language>/`.
Follow existing test patterns in `typescript/` or `ruby/` directories.

Each hook gets own test file testing `process()` with real `HookContext` (use
`createHookContext()` from `types.ts`).

## Step 7: Verify

```bash
npx tsc --noEmit
npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/<language>/
```
