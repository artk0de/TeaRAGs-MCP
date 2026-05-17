# Silo Pairing (MANDATORY for deep-silo files)

Files with `git.file.blameDominantAuthorPct = 100` (deep-silo per tea-rags
signal) carry bus-factor risk. To mitigate without forcing awkward
co-authorship, every commit touching these files must include intent +
trade-offs in the message.

## Files currently classified as deep-silo

(Updated 2026-05-16; re-run `tea-rags:risk-assessment` quarterly to refresh.)

- `src/core/api/internal/ops/indexing-ops.ts`
- `src/core/api/internal/ops/project-registry-ops.ts`
- `src/core/domains/ingest/pipeline/enrichment/recovery.ts`
- `src/core/adapters/qdrant/errors.ts`
- `src/core/api/public/app.ts` (after M4.1 — re-evaluate at next assessment)
- `src/core/api/errors.ts`
- `src/core/domains/explore/errors.ts`
- `src/core/domains/trajectory/errors.ts`
- `src/core/adapters/errors.ts`

## Rule

Commits touching any deep-silo file MUST include a `Why:` line in the body
stating intent and trade-offs. Example:

```text
refactor(ingest): tighten recovery scrollUnenriched cursor lifetime

Why: previous cursor leak caused 3.5s hang on first re-poll after restart.
Trade-off: extra Qdrant call per cycle, acceptable given <50ms latency.
```

## Why no test-time enforcement

This rule is process-only — automated enforcement (commitlint check) would catch
false positives on non-deep-silo files. Reviewers verify on PR.
