# Barrel Files (index.ts)

Every domain boundary directory MUST have an `index.ts` barrel file that
re-exports the public API of that domain.

## Domain boundaries with barrels

- `domains/explore/index.ts`
- `domains/ingest/index.ts`
- `domains/trajectory/index.ts`
- `domains/trajectory/git/index.ts`
- `domains/trajectory/static/index.ts`

## Rules

1. **Import from barrels when crossing domain boundaries.** Instead of
   `import { Reranker } from "../../domains/explore/reranker.js"`, use
   `import { Reranker } from "../../domains/explore/index.js"`.

2. **Deep imports are OK within the same domain.** Files inside `explore/` can
   import directly from `explore/strategies/base.js` without going through
   barrels.

3. **Subdirectory barrels are optional.** `strategies/index.ts`,
   `rerank/presets/index.ts` etc. exist for convenience but are not mandatory
   for every subdirectory. Internal infra/utils directories don't need barrels.

4. **When adding new public exports to a domain**, update the domain barrel. If
   the export is internal to the domain, don't add it.
