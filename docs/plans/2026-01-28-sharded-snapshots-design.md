# Sharded Snapshots & Parallel Change Detection

**Date:** 2026-01-28
**Status:** Approved
**Author:** artk0re

---

## Overview

Redesign snapshot storage and change detection to support parallel processing, improving performance for large codebases.

### Goals

- Parallelize file hash checking using `EMBEDDING_CONCURRENCY` env variable
- Shard snapshot storage for parallel I/O
- Minimize file redistribution when concurrency changes (consistent hashing)
- Two-level Merkle tree for fast "any changes?" check

### Future Improvements (Out of Scope)

- Auto-detection of optimal concurrency based on CPU/IO capacity

---

## Architecture

### Storage Structure

**Current (v2):**
```
~/.tea-rags-mcp/snapshots/
  └── code_a1b2c3d4.json     ← single file
```

**New (v3):**
```
~/.tea-rags-mcp/snapshots/code_a1b2c3d4/
  ├── meta.json              ← ~1KB: version, timestamp, shard root hashes
  ├── shard-00.json          ← files where hash(path) maps to shard 0
  ├── shard-01.json
  ├── ...
  └── shard-{N-1}.json       ← N = EMBEDDING_CONCURRENCY (default: 4)
```

### Data Formats

**`meta.json`:**
```typescript
interface SnapshotMeta {
  version: "3";
  codebasePath: string;
  timestamp: number;
  hashRing: {
    algorithm: "consistent";
    virtualNodesPerShard: number;
    shardCount: number;
  };
  shards: Array<{
    index: number;
    fileCount: number;
    merkleRoot: string;
    checksum: string;         // SHA256 of shard file content
  }>;
  metaRootHash: string;       // Merkle root of shard merkleRoots
}
```

**`shard-XX.json`:**
```typescript
interface ShardData {
  shardIndex: number;
  files: Record<string, FileMetadata>;  // relativePath → {mtime, size, hash}
  merkleRoot: string;
}

interface FileMetadata {
  mtime: number;   // Modification timestamp (ms)
  size: number;    // File size (bytes)
  hash: string;    // SHA256 content hash
}
```

---

## Consistent Hashing

### Why Not Simple Modulo?

```typescript
// Simple modulo: shardIndex = hash(path) % N
// Problem: changing N=4 → N=8 redistributes ~75% of files
```

### Consistent Hash Ring

Each shard gets multiple "virtual nodes" on a ring. When N changes, only ~1/N files need redistribution.

```typescript
class ConsistentHash {
  private ring: Map<number, number> = new Map();
  private sortedPositions: number[] = [];
  private virtualNodes = 150;

  constructor(shardCount: number) {
    for (let shard = 0; shard < shardCount; shard++) {
      for (let v = 0; v < this.virtualNodes; v++) {
        const position = this.hash(`shard-${shard}-vnode-${v}`);
        this.ring.set(position, shard);
      }
    }
    this.sortedPositions = [...this.ring.keys()].sort((a, b) => a - b);
  }

  getShard(filePath: string): number {
    const hash = this.hash(filePath);
    const idx = this.binarySearchCeil(hash);
    const position = this.sortedPositions[idx % this.sortedPositions.length];
    return this.ring.get(position)!;
  }

  private hash(key: string): number {
    // murmurhash3 - faster than SHA256 for this use case
    return murmurhash3(key) >>> 0;
  }
}
```

---

## Parallel Processing

### Main Flow

```typescript
async detectChanges(currentFiles: string[]): Promise<FileChanges> {
  const concurrency = parseInt(process.env.EMBEDDING_CONCURRENCY || "4", 10);
  const hashRing = new ConsistentHash(concurrency);

  // 1. Group files by shard
  const filesByShards: Map<number, string[]> = new Map();
  for (const file of currentFiles) {
    const shardIdx = hashRing.getShard(file);
    if (!filesByShards.has(shardIdx)) {
      filesByShards.set(shardIdx, []);
    }
    filesByShards.get(shardIdx)!.push(file);
  }

  // 2. Process all shards in parallel
  const shardResults = await Promise.all(
    Array.from(filesByShards.entries()).map(([shardIdx, files]) =>
      this.processShardParallel(shardIdx, files)
    )
  );

  // 3. Merge results
  return this.mergeShardResults(shardResults);
}
```

### File Check (mtime+size → hash)

```typescript
async checkFileChange(
  filePath: string,
  prevShard: ShardData | null
): Promise<FileCheckResult> {
  const relativePath = relative(this.codebasePath, filePath);
  const currentMeta = await this.getFileMetadata(filePath);

  if (!currentMeta) {
    return { path: relativePath, status: 'deleted' };
  }

  const cached = prevShard?.files[relativePath];

  // FAST PATH: mtime + size match → unchanged
  if (cached &&
      Math.abs(cached.mtime - currentMeta.mtime) < 1000 &&
      cached.size === currentMeta.size) {
    return { path: relativePath, status: 'unchanged', hash: cached.hash };
  }

  // SLOW PATH: compute hash
  const hash = await this.hashFile(filePath);

  if (!cached) {
    return { path: relativePath, status: 'added', hash };
  }

  if (cached.hash !== hash) {
    return { path: relativePath, status: 'modified', hash };
  }

  // mtime changed but content same (touch, git checkout)
  return { path: relativePath, status: 'unchanged', hash };
}
```

### Parallelism Levels

| Level | What's Parallelized | Limit |
|-------|---------------------|-------|
| 1 | Reading shards from disk | CONCURRENCY |
| 2 | Checking files within shard | CONCURRENCY |
| 3 | Writing shards to disk | CONCURRENCY |

---

## Safety Features

### Atomic Directory Swap

```
snapshots/code_a1b2c3d4/          ← current
snapshots/code_a1b2c3d4.tmp.{ts}/ ← write here first

# After successful write:
rename(code_a1b2c3d4.tmp.{ts}, code_a1b2c3d4)  ← atomic swap
```

If process crashes — `.tmp` directories are cleaned up on next startup.

### Checksum Validation

Each shard has a SHA256 checksum stored in `meta.json`. On read, verify content matches checksum to detect corruption.

### File Locking

```typescript
// Create lock file during writes
snapshots/code_a1b2c3d4.lock   ← flock() or advisory lock

// Stale lock detection: if lock older than 10 minutes → consider stale
```

---

## Migration v2 → v3

Automatic migration on first access (same pattern as v1 → v2):

1. Detect old format (`{collection}.json` exists)
2. Read all file hashes
3. Distribute to shards using consistent hashing
4. Write new sharded format
5. Delete old single file

---

## Testing

### Test Files

```
tests/code/sync/
  ├── consistent-hash.test.ts      ← NEW
  ├── sharded-snapshot.test.ts     ← NEW
  ├── parallel-sync.test.ts        ← NEW
  ├── merkle.test.ts               ← existing
  └── snapshot.test.ts             ← existing (update)
```

### Key Test Cases

**consistent-hash.test.ts:**
- Even distribution across shards
- Minimal redistribution when shard count changes
- Consistent results for same input

**sharded-snapshot.test.ts:**
- Atomic write and read
- Corruption detection via checksum
- Temp directory cleanup on crash recovery
- Migration v2 → v3

**parallel-sync.test.ts:**
- Parallel processing faster than sequential
- Correct merging of results from all shards

### NPM Scripts

```json
{
  "scripts": {
    "test": "vitest run",
    "test:business-logic": "vitest run tests/code/sync/",
    "test:watch": "vitest"
  }
}
```

---

## Implementation Plan

| # | Task | Depends On | Estimate |
|---|------|------------|----------|
| 1 | `ConsistentHash` class + tests | — | 1h |
| 2 | `ShardedSnapshotManager` (read/write/atomic) | #1 | 2h |
| 3 | Checksum validation + tests | #2 | 30m |
| 4 | File locking | #2 | 30m |
| 5 | Two-level Merkle tree integration | #2 | 1h |
| 6 | Update `FileSynchronizer` → parallel | #1, #2, #5 | 2h |
| 7 | Migration v2 → v3 | #2 | 1h |
| 8 | Integration tests (`parallel-sync.test.ts`) | #6 | 1h |
| 9 | README update | — | 30m |
| 10 | Final testing + cleanup | all | 1h |

**Total: ~10-11 hours**

---

## Dependencies

New npm packages needed:

- `murmurhash3js` or `@node-rs/xxhash` — fast hashing for consistent hash ring
- `proper-lockfile` — cross-platform file locking (optional, can use native flock)

---

## Critical Notes

1. **Windows compatibility** — verify atomic rename semantics work correctly
2. **File locking** — decide between `proper-lockfile` npm vs native `flock`
3. **Hash algorithm** — murmurhash3 is fast but not cryptographic (fine for distribution)
