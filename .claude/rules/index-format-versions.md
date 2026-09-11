---
paths:
  - "src/core/domains/language/kernel/**"
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/language/import-file-edges.ts"
  - "src/core/domains/language/external-classifier.ts"
  - "src/core/domains/language/factory.ts"
  - "src/core/domains/language/shared/**"
  - "src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts"
  - "src/core/domains/ingest/pipeline/chunker/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/utils/chunk-id.ts"
  - "src/core/infra/symbolid/**"
  - "src/core/infra/materialize.ts"
  - "src/core/contracts/types/codegraph-*.ts"
---

# Index Format Versions (MANDATORY)

These sources run under EVERY language. A change here moves every language's
output at once, and no `<lang>/capability.ts` number can say so. The stamp is
`sharedVersions` in `src/core/domains/language/kernel/capability.ts`, compared
for the `*` pseudo-language by `LanguageVersionDriftMonitor`.

| Change                                                                                                                                  | Bump                             | Hint recommends                                    |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| chunk id hashing, symbolId classification, chunker boundaries, markdown, AST materialization, symbol mass                               | `sharedVersions.chunking`        | `tea-rags index-codebase --force`                  |
| kernel resolution, resolver chain, cone dispatch, import→file mapping, external classification, the language factory, resolution runner | `sharedVersions.walker`          | `--force-enrichments codegraph` (no `--languages`) |
| edge kinds / columns every language writes (`codegraph-*.ts`, DDL)                                                                      | `sharedVersions.codegraphSchema` | `--force-enrichments codegraph` (no `--languages`) |

Byte-identical change → no bump, but re-pin (`npm run pin:lang-versions`) and a
`Versions: unchanged — <why>` line in the commit body
(`language-capability-sync.md`). The pin test is the gate.

The `paths:` above and `SHARED_SOURCES` in
`src/core/domains/language/capability/version-axes.ts` must name the same files.
A path listed here but digested by nothing turns `sharedVersions` into a number
vouching for code it never saw — the rule fires, the pin stays green, and the
bump gets skipped. Two sources are deliberately outside both:
`language/index.ts` is a re-export barrel and `language/errors.ts` is error
classes, and neither can move a chunk id or an edge.
