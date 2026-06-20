---
title: "Poison-Pill Quarantine"
sidebar_position: 4
---

# Poison-Pill Quarantine

A single file that breaks indexing should not take down the whole pass — and it
should not silently vanish from the index either. When a file fails in a way
that is specific to that file (not a transient outage), TeaRAGs **quarantines**
it: the file is skipped, the failure is recorded on disk, and the file is
**retried automatically on every subsequent index** until it succeeds or you
remove the cause.

This complements the [Failure Model](/operations/failure-model): transient
failures are retried in place; poison-pill files are quarantined and retried
across passes.

## What gets quarantined

A failure is quarantined only when it is attributable to one file and is *not*
transient. Each entry records a stable error code and the pipeline phase it
failed in.

| Error code                  | Phase   | Trigger                                                              |
| --------------------------- | ------- | ------------------------------------------------------------------- |
| `INGEST_FILE_READ_FAILED`   | `fs`    | `readFile` failed — permissions (`EACCES`), broken symlink, etc.    |
| `INGEST_FILE_PARSE_FAILED`  | `parse` | The chunker / tree-sitter threw while parsing the file.             |
| `INGEST_CHUNK_OVERSIZED`    | `embed` | A chunk exceeds the embedding model's context window (in tokens).   |
| `INGEST_EMBEDDING_REJECTED` | `embed` | The embedding provider rejected the input with a 4xx (400/413/422). |

When an embedding batch fails with one of the embed-phase errors, TeaRAGs
**isolates** the batch — it re-embeds the chunks one at a time, quarantines only
the offending file(s), and stores the rest. One oversized chunk no longer aborts
the pass.

## What is NOT quarantined

Transient failures are retried in place (or surface as a typed error) — they are
**not** a property of the file:

- Qdrant unavailable / recovering / timeout (`INFRA_QDRANT_*`).
- Embedding provider 5xx, rate-limits (429), network errors, auth (401).
- Qdrant `413 payload too large` on upsert — handled by the adaptive batch
  sizer, which halves the batch and retries. It is a batch-size signal, not a
  poison file.

## Lifecycle

- **Recorded immediately** — the moment a file fails, so an interrupted pass
  still remembers it.
- **Retried every pass** — `index_codebase` and `reindex_changes` re-attempt
  every quarantined file that still exists, even when its content has not
  changed (a TeaRAGs fix, a permission change, or a larger-context model may
  have made it indexable since).
- **Cleared on success** — a quarantined file that now indexes cleanly is
  removed from the list.
- **Wiped on full reindex** — `forceReindex` / `tea-rags reindex --force` starts
  from a clean slate.

The list lives next to the collection's snapshot as
`<dataDir>/snapshots/<collection>.quarantine.json` and is managed automatically
— you never edit it by hand.

## Seeing what is quarantined

### Quick count (agents)

`get_index_status` includes a `quarantine` block when anything is quarantined:

```json
{
  "isIndexed": true,
  "chunksCount": 3831,
  "quarantine": { "count": 3 }
}
```

An incremental reindex that only re-attempts quarantined files reports them
explicitly instead of "No changes detected":

```text
Incremental re-index complete:
- Files: +0 ~0 -0
  Retried (quarantined): 3
```

### Full list — `tea-rags doctor --quarantine`

For the per-file detail, use the CLI. The human table:

```text
$ tea-rags doctor /path/to/project --quarantine
Quarantined files (2) for code_ddacf778:
  src/vendor/bundle.min.js
    INGEST_CHUNK_OVERSIZED · phase=embed · attempts=3 · last=2026-06-20T07:18:01.928Z
  src/locked.ts
    INGEST_FILE_READ_FAILED · phase=fs · attempts=1 · last=2026-06-20T07:18:01.928Z
```

The `--json` form emits the full structured list — useful for an agent to triage
or help file a GitHub issue:

```bash
tea-rags doctor /path/to/project --quarantine --json
```

```json
{
  "project": "/path/to/project",
  "collectionName": "code_ddacf778",
  "count": 2,
  "files": [
    {
      "path": "src/vendor/bundle.min.js",
      "errorCode": "INGEST_CHUNK_OVERSIZED",
      "errorMessage": "Chunk in \"src/vendor/bundle.min.js\" oversized: ...",
      "phase": "embed",
      "firstFailedAt": "2026-06-20T07:00:00Z",
      "lastFailedAt": "2026-06-20T07:18:01.928Z",
      "attempts": 3
    }
  ]
}
```

## Triaging quarantined files

Use the error code and the file's extension to decide what to do:

| What you see                                         | Likely cause                          | Action                                                                                    |
| ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.min.js`, `.lock`, `.map`, bundles → `OVERSIZED`    | generated / vendored, token-dense     | Add to [ignore patterns](/usage/ignoring-files) — you don't want these in the index.      |
| Real source (`.ts`, `.py`) → `READ_FAILED` (`fs`)    | permissions / broken symlink          | Fix the permission; it clears on the next index.                                          |
| Real source → `CHUNK_OVERSIZED` (`embed`)            | `INGEST_CHUNK_SIZE` larger than the model's token context | Lower `INGEST_CHUNK_SIZE` or use a larger-context embedding model, then reindex.           |
| Real source → `FILE_PARSE_FAILED` (`parse`)          | a chunker edge case                   | Likely a bug — capture `--json` and [file an issue](https://github.com/artk0de/TeaRAGs-MCP/issues). |

Quarantined files are retried automatically, so there is no manual "clear"
step — fixing the cause (or ignoring the file) is all that's needed.

## See also

- [Failure Model](/operations/failure-model) — the broader retry / fallback / typed-error philosophy.
- [Troubleshooting & Error Codes](/operations/troubleshooting-and-error-codes) — every code and its fix.
- [Ignoring Files](/usage/ignoring-files) — keep generated/vendored files out of the index entirely.
