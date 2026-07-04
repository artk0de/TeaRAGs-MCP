---
paths:
  - "src/core/adapters/git/**"
  - "src/core/domains/trajectory/git/infra/walk-commits.ts"
  - "src/core/domains/trajectory/git/infra/chunk-reader.ts"
  - "src/core/domains/ingest/pipeline/enrichment/chunk-phase.ts"
---

# Git object reads MUST use `git cat-file --batch` (never per-call, never iso-git)

## Rule

Bulk git blob/object reads (chunk-churn walk = two blobs per changed file per
commit — tens of thousands per index) go through **persistent**
`createCatFileBatch(repoRoot)` in `src/core/adapters/vcs/git/git-cli/client.ts`. One
long-lived `git cat-file --batch` process per walk by default; close at walk
end.

**Run-scoped sharing (kc93).** Streaming index run: git chunk walk runs once
**per embedding batch** (`buildChunkSignals` per batch). Fresh reader per batch
re-opens pack each batch — on large repo (taxdome) per-batch pack-open dominated
(~minutes wall). So `ChunkPhase` opens **one run-scoped reader** (injected
`BlobReaderFactory` = `createCatFileBatch`, wired in `IngestFacade`), threads it
via `ChunkSignalOptions.blobReader` → `buildChunkChurnMap` → `walkCommits`,
closes it **once at `drain()`** (end of run's chunk work). Injected reader →
`walkCommits` reuses, does NOT close — **caller** owns lifecycle. No injected
reader (recovery / one-off paths, tests) → `walkCommits` spawns+closes own
per-call reader (default above). Pack opened **once per run** not per batch,
same cat-file memory-safety. Run-scoped reader still respects "no idle process":
closed at `drain()`, never cached across runs.

**Never** for bulk reads:

- `git cat-file blob <oid>:<path>` **per call** (`execFile` per blob) — forks
  git process AND re-opens pack `.idx` per read.
- `isomorphic-git` `readBlob`/`readCommit` — pack reader loads **entire packfile
  into a JS `ArrayBuffer`** per cache object.

## Why (measured, not theoretical)

Monitored `force_reindex` of ~24k-file repo (taxdome) drove diagnosis:

- **isomorphic-git `readBlob`** — loads whole pack into JS `ArrayBuffer`; heap
  profiler caught 3×1.4 GB `system / JSArrayBufferData` (× concurrency → ~16 GB)
  → **OOM**. Fast (in-memory pack) but unbounded.
- **per-call `git cat-file blob`** — bounded memory (one object at a time), but
  **41 442 reads ≈ 24 min**: process spawn + `.idx` reopen per read dominated.
- **`git cat-file --batch`** — bounded AND one persistent process (pack opened
  once) → fast. Only approach that is both.

isomorphic-git removed from package entirely (no import, not in `package.json`);
e2e confirmed `external` / `arrayBuffers` peak dropped 16–40 GB → **~0.1 GB**.

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

- **Lazy spawn:** process starts on first `read()`, so a walk reading no blobs
  (all files skipped, empty chunk map) never forks git.
- **FIFO protocol:** requests serialized; responses framed by byte length (blobs
  contain newlines / arbitrary bytes), decoded UTF-8.
- **Lifecycle:** one reader per walk (`walkCommits`), closed in `finally` —
  UNLESS run-scoped reader injected via `WalkCommitsOptions.blobReader`, then
  `walkCommits` reuses it and injector (`ChunkPhase`) closes at run end
  (`drain()`). Either way, don't cache reader across runs — daemon must not hold
  idle git process.

Stateless `readBlobAsString(repoRoot, oid, path)` (single `git cat-file blob`)
remains for **one-off** reads only. Don't call in a loop — reach for
`createCatFileBatch`.

## Related

- Blame parsing has sibling V8 string-retention hazard: `parseBlameOutput` must
  own-copy `sha`/`author`/`email` (else `SlicedString`s of multi-MB porcelain).
  See comment in `src/core/adapters/git/parsers.ts`.
- `git blame --porcelain` results held in `GitEnrichmentProvider.blameByRelPath`
  released after chunk enrichment (last reader) — see `provider.ts`.
