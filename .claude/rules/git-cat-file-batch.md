---
paths:
  - "src/core/adapters/git/**"
  - "src/core/domains/trajectory/git/infra/walk-commits.ts"
  - "src/core/domains/trajectory/git/infra/chunk-reader.ts"
  - "src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts"
---

# Git object reads MUST use `git cat-file --batch` (never per-call, never iso-git)

## Rule

Bulk git blob/object reads (the chunk-churn walk reads two blobs per changed
file per commit — tens of thousands per index) go through the **persistent**
`createCatFileBatch(repoRoot)` reader in `src/core/adapters/git/client.ts`. One
long-lived `git cat-file --batch` process per walk by default; close it when the
walk ends.

**Run-scoped sharing (kc93).** During a streaming index run the git chunk walk
runs once **per embedding batch** (`buildChunkSignals` is called per batch).
Spawning a fresh reader per batch re-opens the pack each batch — on a large repo
(taxdome) that per-batch pack-open dominated (~minutes of wall time). So
`ChunkPhase` opens **one run-scoped reader** (via an injected
`BlobReaderFactory` = `createCatFileBatch`, wired in `IngestFacade`), threads it
through `ChunkSignalOptions.blobReader` → `buildChunkChurnMap` → `walkCommits`,
and closes it **once at `drain()`** (end of the run's chunk work). When a reader
is injected, `walkCommits` reuses it and does NOT close it — the **caller** owns
the lifecycle. Absent an injected reader (recovery / one-off paths, tests),
`walkCommits` spawns and closes its own per-call reader (the default above). The
pack is opened **once per run** instead of once per batch, with the same
cat-file memory-safety. The run-scoped reader still respects "no idle process":
it is closed at `drain()`, never cached across runs.

**Never** do either of these for bulk reads:

- `git cat-file blob <oid>:<path>` **per call** (`execFile` per blob) — forks a
  git process AND re-opens the pack `.idx` on every read.
- `isomorphic-git` `readBlob`/`readCommit` — its pack reader loads the **entire
  packfile into a JS `ArrayBuffer`** per cache object.

## Why (measured, not theoretical)

A monitored `force_reindex` of a ~24k-file repo (taxdome) drove the diagnosis:

- **isomorphic-git `readBlob`** — loads the whole pack into a JS `ArrayBuffer`;
  the heap profiler caught 3×1.4 GB `system / JSArrayBufferData` (× concurrency
  → ~16 GB) → **OOM**. Fast (in-memory pack) but unbounded.
- **per-call `git cat-file blob`** — bounded memory (one object at a time), but
  **41 442 reads ≈ 24 min**: a process spawn + `.idx` reopen per read dominated.
- **`git cat-file --batch`** — bounded AND one persistent process (pack opened
  once) → fast. The only approach that is both.

isomorphic-git was removed from the package entirely (no import, not in
`package.json`); the e2e confirmed the `external` / `arrayBuffers` peak dropped
from 16–40 GB to **~0.1 GB**.

## How

```ts
import { createCatFileBatch } from "../../adapters/git/client.js";

const reader = createCatFileBatch(repoRoot); // lazy: no process until first read()
try {
  const [oldContent, newContent] = await Promise.all([
    reader.read(parentOid, filePath),
    reader.read(commitOid, filePath),
  ]); // "" when the path is absent at that commit
} finally {
  await reader.close(); // ends the git process; later read() rejects
}
```

- **Lazy spawn:** the process starts on the first `read()`, so a walk that reads
  no blobs (all files skipped, empty chunk map) never forks git.
- **FIFO protocol:** requests are serialized; responses are framed by byte
  length (blobs contain newlines / arbitrary bytes), decoded as UTF-8.
- **Lifecycle:** one reader per walk (`walkCommits`), closed in a `finally` —
  UNLESS a run-scoped reader is injected via `WalkCommitsOptions.blobReader`, in
  which case `walkCommits` reuses it and the injector (`ChunkPhase`) closes it
  at run end (`drain()`). Either way, do not cache a reader across runs — the
  daemon must not hold an idle git process.

The stateless `readBlobAsString(repoRoot, oid, path)` (single
`git cat-file blob`) remains for **one-off** reads only. Do not call it in a
loop — reach for `createCatFileBatch`.

## Related

- Blame parsing has a sibling V8 string-retention hazard: `parseBlameOutput`
  must own-copy `sha`/`author`/`email` (they are `SlicedString`s of the multi-MB
  porcelain otherwise). See the comment in `src/core/adapters/git/parsers.ts`.
- `git blame --porcelain` results held in `GitEnrichmentProvider.blameByRelPath`
  are released after chunk enrichment (the last reader) — see `provider.ts`.
