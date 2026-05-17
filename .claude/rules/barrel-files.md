# Barrel Files (index.ts)

Every domain boundary directory MUST have an `index.ts` barrel file that
re-exports the public API of that domain.

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

1. **Import from barrels when crossing domain boundaries.** Instead of
   `import { Reranker } from "../../domains/explore/reranker.js"`, use
   `import { Reranker } from "../../domains/explore/index.js"`.

2. **Deep imports are OK within the same subdomain.** Files inside
   `explore/strategies/` can import each other directly without going through
   `strategies/index.ts`. But once you cross a subdomain boundary (e.g. from
   `ingest/operations/` into `ingest/infra/`), Rule #3 applies — go through the
   subdomain barrel.

3. **Every subdomain directory MUST have an `index.ts` barrel.** A "subdomain"
   is a directory under a domain (`domains/<x>/`) that groups multiple files
   with a shared public surface — examples: `ingest/operations/`,
   `ingest/infra/`, `ingest/sync/`, `ingest/sync/snapshot/`,
   `ingest/sync/deletion/`, `ingest/sync/infra/`. Single-file helper directories
   (e.g. `__helpers__/`) do not need a barrel. Cross-subdomain imports MUST go
   through the barrel, not the file directly.

4. **When adding new public exports to a domain**, update the domain barrel. If
   the export is internal to the domain, don't add it.
