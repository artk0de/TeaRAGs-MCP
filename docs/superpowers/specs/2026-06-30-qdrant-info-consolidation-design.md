# qdrantInfo consolidation — design

Date: 2026-06-30
Status: approved
Branch: worktree-qdrant-1.18-migration

## Problem

The Qdrant-1.18 status work scattered Qdrant-related fields across `IndexStatus`
and introduced a **duplicate size field**:

- `infraHealth.qdrant` already groups `{ available, url, version, status,
  optimizerStatus }` — the de-facto Qdrant info block, rendered by three
  consumers (prime digest, MCP `get_index_status`, CLI `index-progress`).
- A subagent added top-level `diskBytes` + `quantization` (commits `97b0b39f`,
  `7a91c5a3`) — populated by `getStatus` via `QdrantManager.getCollectionDiskBytes`.
- But `indexSizeBytes` (top-level) is the **established** Qdrant on-disk size
  field — populated by the CLI `index-progress/worker.ts` (`resolveIndexSizeBytes`,
  embedded-only FS dir sum), consumed by `index-progress/status-format.ts`
  (human `size:` line + `--json`). Its DTO comment ("never populated, REST API
  exposes no size") is **stale** — it IS populated for embedded.

So `diskBytes` and `indexSizeBytes` measure the **same thing** (embedded
collection storage dir size) via two FS-sum code paths
(`getCollectionDiskBytes` vs `resolveIndexSizeBytes`).

## Decision

Consolidate ALL Qdrant-related status fields into the existing
`infraHealth.qdrant` block. Use `indexSizeBytes` as the single size field; drop
the redundant `diskBytes`. Render on-disk size auto-scaled MB/GB.

### Target shape (both mirrors: `core/types.ts` + `api/public/dto/ingest.ts`)

```ts
infraHealth.qdrant: {
  available: boolean;
  url: string;
  status?: "green" | "yellow" | "red";
  optimizerStatus?: string;
  version?: string;
  indexSizeBytes?: number;             // MOVED from top-level — embedded FS size
  quantization?: "turbo" | "scalar" | "none";   // MOVED from subagent top-level
}
```

Field deltas:

- **ADD** `indexSizeBytes?` + `quantization?` to `infraHealth.qdrant`.
- **REMOVE** top-level `diskBytes` (subagent, redundant), top-level
  `quantization` (subagent), top-level `indexSizeBytes` (moved into block).
- **KEEP** top-level `codegraphSizeBytes` — codegraph DB size, not Qdrant.
- **KEEP** top-level `qdrantUrl` — it is the registry-entry/config URL consumed
  widely (cli registry-resolver, projects, worktree-provisioner); NOT the status
  block. Out of scope.
- **FIX** the stale `indexSizeBytes` doc comment.

### Single size source

`QdrantManager.getCollectionDiskBytes(name)` (alias-resolving, embedded-only)
is THE FS-sum. `getStatus` populates `infraHealth.qdrant.indexSizeBytes` from it
and `infraHealth.qdrant.quantization` from `getCollectionInfo`. The CLI worker's
`resolveIndexSizeBytes` overlay is **removed** — the worker already calls
`getIndexStatus`, so the size arrives inside the block (dedup). The worker keeps
`resolveCodegraphSizeBytes` (separate, top-level `codegraphSizeBytes`).

### Format

On-disk size auto-scaled: `< 1 GB → "501.0 MB"`, `≥ 1 GB → "1.2 GB"` (one
decimal). Applied in every renderer (prime `formatBytes`, MCP `formatBytes`,
index-progress `humanBytes`).

## Affected files

| File | Change |
|---|---|
| `core/types.ts` | `infraHealth.qdrant`: +indexSizeBytes +quantization; drop top-level diskBytes/quantization/indexSizeBytes; fix comment |
| `core/api/public/dto/ingest.ts` | mirror of above |
| `core/api/internal/ops/indexing-ops.ts` (`getStatus`) | populate `infraHealth.qdrant.{indexSizeBytes,quantization}`; drop top-level diskBytes/quantization assignment |
| `cli/index-progress/worker.ts` | drop `resolveIndexSizeBytes` overlay; rely on getStatus block; keep codegraphSizeBytes |
| `cli/index-progress/status-format.ts` | read `infraHealth.qdrant.indexSizeBytes`; render quantization on qdrant line; GB-auto `humanBytes` |
| `cli/prime/format.ts` | read `infraHealth.qdrant.{indexSizeBytes,quantization}`; GB-auto `formatBytes` |
| `mcp/tools/code/register-status-tools.ts` | `formatCollectionDetails` reads from `infraHealth.qdrant`; GB-auto `formatBytes` |
| tests for each | lockstep update |

## Risk

`getStatus` + `prime/format.ts` are high-churn hotspots (tea-rags: getStatus
commitCount 21, chunk relativeChurn 4.31 high, instability 1; prime a hub via
`runPrime` transitiveImpact 12). `infraHealth.qdrant` --json is a stable
contract consumed by agents. Mitigation: TDD, update all three consumers in
lockstep, keep `--json` field shape additive within the block.

## Out of scope

- Named Vectors API (`bx9m4`).
- `codegraphSizeBytes` relocation (not Qdrant).
- Top-level `qdrantUrl` (config/registry URL, not the status block).
