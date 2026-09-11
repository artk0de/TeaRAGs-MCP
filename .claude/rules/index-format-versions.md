---
paths:
  - "src/core/domains/language/kernel/**"
  - "src/core/domains/language/resolver-chain.ts"
  - "src/core/domains/language/cone-dispatch.ts"
  - "src/core/domains/trajectory/codegraph/symbols/resolution-runner.ts"
  - "src/core/domains/ingest/pipeline/chunker/*.ts"
  - "src/core/domains/ingest/pipeline/chunker/utils/chunk-id.ts"
  - "src/core/infra/symbolid/**"
  - "src/core/contracts/types/codegraph-*.ts"
---

# Index Format Versions (MANDATORY)

These sources run under EVERY language. A change here moves every language's
output at once, and no `<lang>/capability.ts` number can say so. The stamp is
`sharedVersions` in `src/core/domains/language/kernel/capability.ts`, compared
for the `*` pseudo-language by `LanguageVersionDriftMonitor`.

| Change                                                                  | Bump                             | Hint recommends                                    |
| ----------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| chunk id hashing, symbolId classification, chunker boundaries, markdown | `sharedVersions.chunking`        | `tea-rags index-codebase --force`                  |
| kernel resolution, resolver chain, cone dispatch, resolution runner     | `sharedVersions.walker`          | `--force-enrichments codegraph` (no `--languages`) |
| edge kinds / columns every language writes (`codegraph-*.ts`, DDL)      | `sharedVersions.codegraphSchema` | `--force-enrichments codegraph` (no `--languages`) |

Byte-identical change → no bump, but re-pin (`npm run pin:lang-versions`) and a
`Versions: unchanged — <why>` line in the commit body
(`language-capability-sync.md`). The pin test is the gate.
