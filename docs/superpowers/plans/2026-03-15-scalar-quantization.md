# Scalar Quantization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable int8 scalar quantization via `QDRANT_QUANTIZATION_SCALAR=true`
env var to reduce Qdrant RAM usage ~4x for large codebases.

**Architecture:** Add boolean flag to config layer → thread through DI to
QdrantManager.createCollection() → apply Qdrant quantization_config at
collection creation time. No MCP tool changes.

**Tech Stack:** TypeScript, Zod, Qdrant JS client v1.16.2, Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-scalar-quantization-design.md`

---

## Chunk 1: Config + QdrantManager

### Task 1: Config layer — add quantizationScalar to QdrantTuneConfig

**Files:**

- Modify: `src/core/contracts/types/config.ts:36-43`
- Modify: `src/bootstrap/config/schemas.ts:77-84`
- Modify: `src/bootstrap/config/parse.ts:89-96`
- Modify: `src/bootstrap/config/index.ts:64-73` (inside `parseAppConfig()`)
- Modify: `src/core/types.ts:6-25`
- Test: `tests/bootstrap/qdrant-tune-env.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/bootstrap/qdrant-tune-env.test.ts`:

1. Add `"QDRANT_QUANTIZATION_SCALAR"` to the `ENV_VARS` tuple declaration (line
   9-31). This is a `const ... as const` tuple — add the new entry directly in
   the array literal, e.g. after line 30 (`"DELETE_FLUSH_TIMEOUT_MS"`):

```typescript
"QDRANT_QUANTIZATION_SCALAR",
```

2. Add tests inside the `"config.ts integration"` describe block (before the
   closing `});` on line 253):

```typescript
it("parseAppConfigZod reads QDRANT_QUANTIZATION_SCALAR", async () => {
  process.env.QDRANT_QUANTIZATION_SCALAR = "true";
  vi.resetModules();
  const { parseAppConfigZod } =
    await import("../../src/bootstrap/config/index.js");
  const config = parseAppConfigZod();
  expect(config.qdrantTune.quantizationScalar).toBe(true);
  cleanEnv();
});

it("QDRANT_QUANTIZATION_SCALAR defaults to false", async () => {
  vi.resetModules();
  const { parseAppConfigZod } =
    await import("../../src/bootstrap/config/index.js");
  const config = parseAppConfigZod();
  expect(config.qdrantTune.quantizationScalar).toBe(false);
  cleanEnv();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bootstrap/qdrant-tune-env.test.ts` Expected: FAIL —
`quantizationScalar` does not exist on type

- [ ] **Step 3: Implement config changes**

**`src/core/contracts/types/config.ts`** — add field after
`deleteFlushTimeoutMs` (line 42), before the closing `}`:

```typescript
quantizationScalar: boolean;
```

**`src/bootstrap/config/schemas.ts`** — add field to `qdrantTuneSchema` after
`deleteFlushTimeoutMs` (line 83), before the closing `})`:

```typescript
quantizationScalar: booleanFromEnv,
```

**`src/bootstrap/config/parse.ts`** — add to `qdrantTuneInput` after
`deleteFlushTimeoutMs` (line 95), before the closing `}`:

```typescript
quantizationScalar: env("QDRANT_QUANTIZATION_SCALAR"),
```

**`src/core/types.ts`** — add to `IngestCodeConfig` after `enableHybridSearch`
(line 21). Place it in the same `// Search` section:

```typescript
quantizationScalar: boolean;
```

**`src/bootstrap/config/index.ts`** — add to `ingestCode` object inside
`parseAppConfig()` (lines 64-73), after `enableGitMetadata` (line 70):

```typescript
quantizationScalar: zodConfig.qdrantTune.quantizationScalar,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/bootstrap/qdrant-tune-env.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite to check nothing broke**

Run: `npx vitest run` Expected: Some tests may fail due to missing
`quantizationScalar` in test fixtures for `IngestCodeConfig`. If so, add
`quantizationScalar: false` to `defaultTestConfig()` in
`tests/core/domains/ingest/__helpers__/test-helpers.ts` and any other test
fixtures constructing `IngestCodeConfig`. Search for `enableHybridSearch` in
tests to find all fixture locations.

- [ ] **Step 6: Commit**

```bash
git add src/core/contracts/types/config.ts src/bootstrap/config/schemas.ts \
  src/bootstrap/config/parse.ts src/bootstrap/config/index.ts \
  src/core/types.ts tests/bootstrap/qdrant-tune-env.test.ts
git commit -m "feat(config): add QDRANT_QUANTIZATION_SCALAR env flag"
```

If test helpers were modified, include them in the commit too.

### Task 2: QdrantManager.createCollection — add quantization support

**Files:**

- Modify: `src/core/adapters/qdrant/client.ts:53-102`
- Create: `tests/core/adapters/qdrant/quantization.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/adapters/qdrant/quantization.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant client
vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    createCollection: vi.fn().mockResolvedValue(true),
  })),
}));

describe("QdrantManager.createCollection — quantization", () => {
  let manager: QdrantManager;
  let mockClient: { createCollection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
    // Access the internal client mock
    mockClient = (manager as any).client;
  });

  it("includes scalar quantization config when quantizationScalar=true", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, true);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { size: 384, distance: "Cosine" },
      quantization_config: {
        scalar: { type: "int8", always_ram: true },
      },
    });
  });

  it("includes scalar quantization with sparse vectors", async () => {
    await manager.createCollection("test-col", 384, "Cosine", true, true);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { dense: { size: 384, distance: "Cosine" } },
      sparse_vectors: { text: { modifier: "idf" } },
      quantization_config: {
        scalar: { type: "int8", always_ram: true },
      },
    });
  });

  it("omits quantization config when quantizationScalar=false", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, false);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { size: 384, distance: "Cosine" },
    });
  });

  it("omits quantization config by default (no 5th arg)", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false);

    const callArgs = mockClient.createCollection.mock.calls[0];
    const config = callArgs[1];
    expect(config).not.toHaveProperty("quantization_config");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/qdrant/quantization.test.ts` Expected:
FAIL — `createCollection` doesn't accept 5th argument / no quantization_config
in output

- [ ] **Step 3: Implement QdrantManager changes**

In `src/core/adapters/qdrant/client.ts`, modify `createCollection` (lines
53-102):

1. Add 5th parameter to method signature:

```typescript
async createCollection(
  name: string,
  vectorSize: number,
  distance: "Cosine" | "Euclid" | "Dot" = "Cosine",
  enableSparse = false,
  quantizationScalar = false,
): Promise<void> {
```

2. Extend local `CollectionConfig` interface (lines 72-79) — add after
   `sparse_vectors?`:

```typescript
quantization_config?: {
  scalar: {
    type: "int8";
    always_ram: boolean;
  };
};
```

3. After building the config object (after line 100), add before the
   `this.client.createCollection` call:

```typescript
if (quantizationScalar) {
  config.quantization_config = {
    scalar: { type: "int8", always_ram: true },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/qdrant/quantization.test.ts` Expected:
PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS (existing createCollection calls still have
4 args, 5th defaults to false)

- [ ] **Step 6: Commit**

```bash
git add src/core/adapters/qdrant/client.ts tests/core/adapters/qdrant/quantization.test.ts
git commit -m "feat(qdrant): add scalar quantization support to createCollection"
```

## Chunk 2: Wiring

### Task 3: Wire quantizationScalar through CollectionOps and AppDeps

**Files:**

- Modify: `src/core/api/internal/ops/collection-ops.ts`
- Modify: `src/core/api/public/app.ts:84-98`
- Modify: `src/bootstrap/factory.ts:136-143`
- Modify: `tests/core/api/collection-ops.test.ts`

- [ ] **Step 1: Update existing tests and add new test**

In `tests/core/api/collection-ops.test.ts`:

Update `beforeEach` (line 37-41) — pass `false` as 3rd arg:

```typescript
ops = new CollectionOps(qdrant, embeddings, false);
```

Update **all** `CollectionOps` constructor calls in the file. There is a second
one on line 73 (`"uses embedding provider dimensions"` test) that also needs the
3rd arg:

```typescript
ops = new CollectionOps(qdrant, embeddings, false);
```

Update all `toHaveBeenCalledWith` assertions for `qdrant.createCollection` to
include `false` as 5th arg:

- Line 47: `...("my-col", 384, undefined, false, false)`
- Line 60: `...("my-col", 384, "Dot", false, false)`
- Line 67: `...("my-col", 384, undefined, true, false)`
- Line 77: `...("my-col", 768, undefined, false, false)`

Add new test after the `"uses embedding provider dimensions"` test:

```typescript
it("passes quantizationScalar to qdrant.createCollection", async () => {
  ops = new CollectionOps(qdrant, embeddings, true);
  await ops.create({ name: "my-col" });

  expect(qdrant.createCollection).toHaveBeenCalledWith(
    "my-col",
    384,
    undefined,
    false,
    true,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/collection-ops.test.ts` Expected: FAIL —
CollectionOps constructor expects 2 args

- [ ] **Step 3: Implement CollectionOps + AppDeps + factory wiring**

**`src/core/api/internal/ops/collection-ops.ts`** — modify the constructor and
`create` method only. Do NOT touch `list`, `getInfo`, `delete` methods:

Constructor (line 10-13) becomes:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  private readonly embeddings: EmbeddingProvider,
  private readonly quantizationScalar: boolean,
) {}
```

`create` method (line 19) — add 5th arg to `createCollection` call:

```typescript
await this.qdrant.createCollection(
  request.name,
  vectorSize,
  request.distance,
  enableHybrid,
  this.quantizationScalar,
);
```

**`src/core/api/public/app.ts`** — add `quantizationScalar: boolean` to the
`AppDeps` interface (after `schemaDriftMonitor` on line 90):

```typescript
quantizationScalar: boolean;
```

Update `createApp` (line 98) to pass the new field:

```typescript
const collectionOps = new CollectionOps(
  deps.qdrant,
  deps.embeddings,
  deps.quantizationScalar,
);
```

**`src/bootstrap/factory.ts`** — add `quantizationScalar` to the `createApp()`
call object literal (lines 136-143):

```typescript
quantizationScalar: zodConfig.qdrantTune.quantizationScalar,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/collection-ops.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/api/internal/ops/collection-ops.ts src/core/api/public/app.ts \
  src/bootstrap/factory.ts tests/core/api/collection-ops.test.ts
git commit -m "feat(qdrant): wire quantizationScalar through CollectionOps and AppDeps"
```

### Task 4: Wire quantizationScalar through IndexPipeline

**Files:**

- Modify: `src/core/domains/ingest/indexing.ts:67`
- Modify: `tests/core/domains/ingest/indexing.test.ts` (if exists)

- [ ] **Step 1: Write the failing test**

Find the existing IndexPipeline test
(`tests/core/domains/ingest/indexing.test.ts`). Locate the test that covers
`createCollection` call — look for assertions on `qdrant.createCollection`. Add
or update test to assert 5th arg:

```typescript
it("passes quantizationScalar to createCollection", async () => {
  // Setup with quantizationScalar: true in config
  // Run indexCodebase
  // Assert: qdrant.createCollection called with 5th arg = true
});
```

If no direct test for `createCollection` call exists, add one. The test fixture
config should set `quantizationScalar: true` and assert the value reaches
`qdrant.createCollection`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/domains/ingest/indexing.test.ts` Expected: FAIL
— `createCollection` called with 4 args, not 5

- [ ] **Step 3: Implement IndexPipeline change**

In `src/core/domains/ingest/indexing.ts`, line 67, change:

```typescript
await this.qdrant.createCollection(
  collectionName,
  vectorSize,
  "Cosine",
  this.config.enableHybridSearch,
);
```

to:

```typescript
await this.qdrant.createCollection(
  collectionName,
  vectorSize,
  "Cosine",
  this.config.enableHybridSearch,
  this.config.quantizationScalar,
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/domains/ingest/indexing.test.ts` Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/indexing.ts tests/core/domains/ingest/indexing.test.ts
git commit -m "feat(ingest): pass quantizationScalar to collection creation in IndexPipeline"
```
