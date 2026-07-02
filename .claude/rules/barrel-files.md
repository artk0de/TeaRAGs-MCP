---
paths:
  - "src/core/domains/**"
---

# Barrel Files (index.ts)

Every domain boundary directory MUST have `index.ts` barrel re-exporting that
domain's public API.

## Domain boundaries with barrels

- `domains/explore/index.ts`
- `domains/ingest/index.ts`
- `domains/trajectory/index.ts`
- `domains/trajectory/git/index.ts`
- `domains/trajectory/static/index.ts`
- `domains/ingest/operations/index.ts`
- `domains/ingest/infra/index.ts`
- `domains/ingest/sync/index.ts`
- `domains/ingest/sync/snapshot/index.ts`
- `domains/ingest/sync/deletion/index.ts`
- `domains/ingest/sync/infra/index.ts`

## Rules

1. **Import from barrels when crossing domain boundaries.** Not
   `import { Reranker } from "../../domains/explore/reranker.js"`, use
   `import { Reranker } from "../../domains/explore/index.js"`.

2. **Deep imports OK within same subdomain.** Files in `explore/strategies/`
   import each other directly, no `strategies/index.ts`. But crossing a
   subdomain boundary (e.g. `ingest/operations/` into `ingest/infra/`) → Rule #3
   applies — go through subdomain barrel.

3. **Every subdomain directory MUST have `index.ts` barrel.** "Subdomain" =
   directory under a domain (`domains/<x>/`) grouping multiple files with shared
   public surface — e.g. `ingest/operations/`, `ingest/infra/`, `ingest/sync/`,
   `ingest/sync/snapshot/`, `ingest/sync/deletion/`, `ingest/sync/infra/`.
   Single-file helper dirs (e.g. `__helpers__/`) don't need barrel.
   Cross-subdomain imports MUST go through barrel, not file directly.

4. **Adding new public exports to a domain** → update domain barrel. Export
   internal to domain → don't add.
