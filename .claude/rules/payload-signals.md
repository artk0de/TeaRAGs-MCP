---
paths:
  - "src/core/trajectory/**/payload-signals.ts"
  - "src/core/trajectory/**/types.ts"
  - "src/core/trajectory/**/infra/metrics*.ts"
---

# Payload Signal Descriptors

Applies to all trajectory providers. Each provider defines its own `PayloadSignalDescriptor[]` array.

## Structure (MANDATORY)

Payload signal descriptors are a **flat array** of `PayloadSignalDescriptor`.

Every signal is an explicit object — NO computed patterns, NO `.map()`, NO spread operators.

```typescript
// CORRECT — explicit flat list
export const myPayloadSignalDescriptors: PayloadSignalDescriptor[] = [
  { key: "provider.file.commitCount", type: "number", description: "Total commits modifying this file", stats: { percentiles: [25, 50, 75, 95] } },
  { key: "provider.chunk.commitCount", type: "number", description: "Commits touching this specific chunk", stats: { percentiles: [95] } },
];

// WRONG — never do this
...(["commitCount", "ageDays"].map(suffix => ({ key: `provider.chunk.${suffix}`, ... })))
```

## Naming Convention

| Level | Key format | Example (git provider) |
|-------|-----------|------------------------|
| File | `<provider>.file.<field>` | `git.file.commitCount` |
| Chunk | `<provider>.chunk.<field>` | `git.chunk.commitCount` |

## Adding a New Payload Signal

### Checklist (ALL steps mandatory)

1. **Add type field** to the provider's file/chunk signal interface in `types.ts`
2. **Add computation** in the provider's `computeFileSignals()` or `computeChunkSignals()`
3. **Add descriptor** to the payload signal descriptors array
4. **Add `stats` field** if numeric and consumed by derived signals or adaptive bounds
5. **Add/update filter** in the provider's `filters.ts` if the signal is user-filterable
6. **Update CLAUDE.md** — add to `tea-rags API SELECTION` filter fields table and search examples
7. **Update website docs** — `website/docs/usage/git-enrichments.md`, `website/docs/architecture/data-model.md`, `website/docs/usage/filters.md` as applicable
8. **Add tests** — computation tests, descriptor tests (`signals.test.ts`), filter tests (`filters.test.ts`)

### Modifying an Existing Signal

1. Update computation logic
2. Update descriptor if `type`, `description`, or `stats` changed
3. Update filters if key or semantics changed
4. Update CLAUDE.md if user-facing behavior changed
5. Update website docs if user-facing behavior changed
6. Update all affected tests

### Removing a Signal

1. Remove type field from interface
2. Remove computation
3. Remove descriptor from payload signal descriptors array
4. Remove related filter(s) from `filters.ts`
5. Remove/update any derived signals that depend on it
6. Update CLAUDE.md — remove from filter fields table and examples
7. Update website docs — remove from `git-enrichments.md`, `data-model.md`, `filters.md`
8. Remove/update all affected tests

### Stats Declaration

Numeric signals consumed by derived signals or adaptive bounds MUST declare `stats`:

```typescript
// p25 needed for dampening threshold:
{ key: "provider.file.commitCount", stats: { percentiles: [25, 50, 75, 95] } }

// p95 needed for adaptive bounds:
{ key: "provider.file.ageDays", stats: { percentiles: [95] } }

// Not consumed by derived signals — no stats:
{ key: "provider.file.taskIds", type: "string[]", description: "..." }
```

## File/Chunk Signal Parity

Some file-level signals have chunk-level equivalents. These are **independent descriptors** — not derived from file-level via computation.

Each provider defines its own parity. Not all file signals need chunk equivalents — only those where chunk-level granularity adds meaningful discrimination.

## Verification

After any change to payload signals:
```bash
npx tsc --noEmit && npx vitest run
```
