# Test Patterns

## Setup

- Runner: `npx vitest run`
- Setup file: `tests/vitest.setup.ts`
- Env: `DEBUG=true`, `MAX_TOTAL_CHUNKS=1000`, `CHUNKER_POOL_SIZE=1`
- Temp dir: `$TEA_RAGS_DATA_DIR` (auto-cleaned)

## Test helpers

**`tests/core/domains/ingest/__helpers__/test-helpers.ts`** provides:

- `MockQdrantManager` — in-memory Qdrant with full CRUD
- `MockEmbeddingProvider` — returns fixed 384-dim vectors
- `createTestFile(dir, name, content)` — write test files
- `createTempTestDir()` — isolated temp directory
- `defaultTestConfig()` — IngestCodeConfig defaults

## Mocking conventions

**Tree-sitter**: mock per-test-file (not globally) to avoid breaking chunker
unit tests:

```typescript
vi.mock("tree-sitter", () => ({
  default: class MockParser {
    parse() {
      return { rootNode: { type: "program", children: [], text: "" } };
    }
  },
}));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));
```

**Git/filesystem**: mock selectively via `vi.mock()` + `vi.mocked()`:

```typescript
vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, existsSync: vi.fn() };
});
```

**Derived signals**: test with plain objects, no mocks needed:

```typescript
const signal = new RecencySignal();
const result = signal.extract(
  { "git.file.ageDays": 30 },
  { bounds: { "file.ageDays": 365 } },
);
```

## Domain-specific patterns

| Domain     | What to mock                       | Helper to use           |
| ---------- | ---------------------------------- | ----------------------- |
| Explore    | Reranker (vi.fn), scroll functions | Manual mock objects     |
| Ingest     | Tree-sitter, filesystem            | `test-helpers.ts`       |
| Trajectory | Git client, file-reader, fs        | `vi.mock` + `vi.mocked` |
| Signals    | Nothing — pure functions           | Direct instantiation    |
| Presets    | Nothing — pure data                | Direct instantiation    |
