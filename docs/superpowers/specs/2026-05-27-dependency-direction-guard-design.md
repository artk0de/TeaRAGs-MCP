# Dependency Direction Guard — Full Layer Matrix

**Date:** 2026-05-27 **Status:** Approved (design) **Beads:** core task
`tea-rags-mcp-qbod` (enable guard); epic + per-violation tasks created alongside
the implementation plan. **Supersedes scope of:** `tea-rags-mcp-qbod` ("Extend
eslint dependency-guard to full domain-boundaries matrix") — this spec widens it
from the `core/` matrix to the whole `src/` tree (outer layers
`cli`/`mcp`/`bootstrap`/`index.ts`).

## Problem

The leaf-domain guard in `eslint.config.js` (two
`@typescript-eslint/no-restricted-imports` blocks) currently constrains ONLY
`domains/language` directionality. Nothing enforces:

- mutual isolation of the other domains (`explore` / `trajectory` / `ingest`);
- foundation purity (`contracts` / `adapters` / `infra` not importing upward);
- the outer-layer ordering (`cli` / `mcp` / `bootstrap` / `index.ts`), which
  `domain-boundaries.md` does not document at all.

Without enforcement the tree has accreted cross-layer leaks (enumerated below).

## Goal

A single eslint guard that encodes the **complete allowed-direction matrix** for
every layer, top to bottom, enforced for runtime AND type imports alike.

## Layer order (top → bottom)

`bin → build/cli/index.js`, so `cli` is the process entry; the MCP server is a
cli command (`cli/commands/server.ts`). There is no `cli ↔ mcp` coupling.

```
cli (entry)
  → bootstrap (composition root)
      → mcp (tool surface)
          → core/api (core composition root)
              → core/domains/{explore,trajectory,ingest,language}
                  → core/{contracts, adapters, infra}
```

## Allowed-direction matrix

Allowed = ONLY the listed targets (plus the layer's own files and external npm
packages). Everything else is an error — **including `import type`** (strict
model, no `allowTypeImports` escape hatch).

| Layer (`files`)              | Allowed import targets                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `src/cli/**`                 | `src/bootstrap/**` · `src/core/api/public/**`                                                 |
| `src/mcp/**`                 | `src/core/api/public/**`                                                                      |
| `src/bootstrap/**`           | `src/mcp/**` · `src/core/api/**` · `core/contracts/**` · `core/adapters/**` · `core/infra/**` |
| `src/index.ts`               | `src/bootstrap/**`                                                                            |
| `src/core/api/**`            | `core/domains/**` · `core/contracts/**` · `core/adapters/**` · `core/infra/**`                |
| `core/domains/explore/**`    | `core/contracts/**` · `core/adapters/**` · `core/infra/**`                                    |
| `core/domains/trajectory/**` | `core/contracts/**` · `core/adapters/**` · `core/infra/**`                                    |
| `core/domains/ingest/**`     | `core/contracts/**` · `core/adapters/**` · `core/infra/**`                                    |
| `core/domains/language/**`   | `core/contracts/**` · `core/infra/**` _(leaf)_                                                |
| `core/contracts/**`          | — _(pure: external packages/types only, zero `core/` deps)_                                   |
| `core/adapters/**`           | `core/infra/**`                                                                               |
| `core/infra/**`              | — _(nothing but external packages)_                                                           |

### Invariants

1. **Domains never import each other** (`explore`/`trajectory`/`ingest`/
   `language` are mutually isolated). The concrete `language` module is
   reachable only from `bootstrap`/`api` composition + the chunker worker root —
   already enforced by the existing reverse guard.
2. **`api/public` is the single core surface for `cli`/`mcp`.** Outer layers do
   NOT import `core/contracts`, `core/adapters`, `core/infra`, or
   `core/api/internal` directly. Types live internally in `contracts`; runtime
   lives in its layer; **`api/public` re-exports outward everything consumers
   need** (types + runtime + error classes).
3. **`core/contracts` is pure** — interfaces/types only, zero `core/`
   dependencies (not even `infra`). Already true in the code today; this is a
   doc/guard alignment, not a code move.
4. **`core/infra` is NOT universal for outer layers.** `cli`/`mcp` reach
   foundation utilities only through `api/public`. Within `core`, `domains`/
   `api`/`adapters` may import `infra`.
5. **`bootstrap` is the application composition root** — the only outer layer
   with broad `core` access (full `api` barrel incl. internal, plus contracts/
   adapters/infra), analogous to how `api/` is the composition root inside
   `core`.

## Fix-dispatch principle (by symbol kind)

Everything `cli`/`mcp` consume flows through `api/public`. The internal home of
each symbol is chosen by kind:

- **Pure type / interface** needed by consumers → relocate to `core/contracts`
  (clean home) → `api/public` re-exports it.
- **Runtime class / function / value** → stays in its layer → `api/public`
  re-exports it.
- **Infrastructure construction** (e.g. `QdrantManager`) → injected via the
  `bootstrap` factory; consumers never construct it.

## Mechanism

Extend the existing `@typescript-eslint/no-restricted-imports` pattern: one
config block per `files` scope, each listing the **forbidden** glob groups
(deny-list) with an explanatory `message`. ~10 blocks total.

- No new eslint plugin. `eslint-plugin-boundaries` (allow-list, purpose-built
  for layered matrices) is rejected: it requires plugin approval per
  `.claude/rules/linter-config.md` and contradicts "minimal config change".
- Deny-list completeness risk (forgetting to forbid a layer) is mitigated by a
  comment block documenting the full matrix above each rule and by the rollout
  step that runs the guard against the whole tree (any missed edge surfaces as a
  passing import that should have failed — caught in review).
- Glob groups match the import specifier string (gitignore-style), exactly as
  the current `domains/language` guard already does (`**/ingest/**` etc.).

## Current violations against the matrix (must be fixed BEFORE enabling)

Rollout decision: **fix every violation first, then enable the full matrix in a
single commit.** CI stays green at every step.

| Violation                                                               | Count | Kind         | Fix                                                                       |
| ----------------------------------------------------------------------- | ----- | ------------ | ------------------------------------------------------------------------- |
| `mcp → core/api/index` (App, DTO, createApp)                            | 16    | mixed        | redirect to `api/public`                                                  |
| `mcp → core/api/errors` (InputValidationError …)                        | 3     | runtime      | re-export via `api/public`                                                |
| `mcp → core/infra/errors` (TeaRagsError, UnknownError)                  | 1     | runtime      | re-export via `api/public`                                                |
| `mcp → core/infra/registry` (PROJECT_NAME_RE)                           | 2     | value        | re-export via `api/public`                                                |
| `mcp → core/contracts/types/trajectory` (PayloadSignalDescriptor)       | 1     | type         | re-export via `api/public`                                                |
| `mcp → core/domains/ingest/.../enrichment/types` (EnrichmentHealthMap)  | 1     | type         | relocate type → `contracts`; consume via `api/public`                     |
| `mcp → core/types` (IngestCodeConfig)                                   | 1     | type         | relocate `core/types.ts` → `contracts`; consume via `api/public`          |
| `mcp → bootstrap/errors` (ConfigValueInvalidError)                      | 1     | runtime      | relocate error class out of `bootstrap`; consume via `api/public`         |
| `cli → core/infra/registry` (CollectionRegistry / CollectionEntry / RE) | 4     | runtime+type | Registry+RE → `api/public`; CollectionEntry type → `contracts`            |
| `cli → core/infra/collection-name` (resolveCollectionName)              | 1     | runtime      | re-export via `api/public`                                                |
| `cli → core/adapters` (QdrantManager / EmbeddingProvider)               | 3     | runtime+type | QdrantManager → `bootstrap` factory; EmbeddingProvider type → `contracts` |
| `cli → core/api/internal/ops` (ProjectRegistryOps)                      | 2     | runtime      | expose facade in `api/public`                                             |
| `cli → core/api/errors`                                                 | 1     | runtime      | re-export via `api/public`                                                |
| `explore → trajectory`                                                  | 1     | —            | cut (data flows via DI per domain-boundaries.md)                          |
| `trajectory → ingest` (codegraph/provider → ingest walker)              | 1     | —            | cut — **precondition** (tracked separately, see qbod note)                |

The `trajectory → ingest` cut (codegraph `provider.ts` → ingest `*-walker.js`)
is the long-standing blocker flagged on `qbod`; the blanket
`ingest ↔ trajectory` edge cannot go green until it lands.

## Documentation changes (`.claude/rules/domain-boundaries.md`)

- **Line 27** — `explore` imports row: add `adapters`. Reality: 8 explore files
  import `adapters` for Qdrant types; the doc was stricter than the code.
  Allowed going forward: `explore → contracts, adapters, infra`.
- **Line 30** — `contracts` row: imports from **nothing** (pure), not `infra`.
- **Add outer-layer rows** to the dependency table: `cli`, `mcp`, `bootstrap`,
  `index.ts` with their allowed targets per the matrix above.
- **Add the rule** that `cli`/`mcp` reach `core` only through `api/public` (not
  `api/internal`, not `contracts`/`adapters`/`infra` directly), and that
  `api/public` is the curated re-export facade.

## Testing

- The guard itself is verified by eslint passing on the full tree post-fixes
  (`npm run lint` green).
- Each violation fix preserves behavior; existing unit/integration tests guard
  against regressions (no test rewrites — relocations only, per
  `.claude/rules/test-patterns.md`).
- Optional: a focused fixture test that a deliberately-wrong import (e.g.
  `mcp → core/adapters`) trips the guard, mirroring how the language guard is
  trusted.

## Out of scope

- Switching to an allow-list plugin (`eslint-plugin-boundaries`).
- Refactoring beyond what each violation fix requires.
- Re-homing `core/types.ts` content beyond the single `IngestCodeConfig` move
  needed to clear the `mcp → core/types` edge (broader `core/types.ts` cleanup
  is a separate concern).
