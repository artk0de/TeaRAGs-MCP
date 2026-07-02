---
paths:
  - "src/core/domains/language/**"
---

# Language Capability Sync (MANDATORY)

Change a chunker hook, resolver chain, walker, or test detection for a language
under `src/core/domains/language/<lang>/` → change may move that language's
capability tier. You MUST:

1. Re-review `src/core/domains/language/<lang>/capability.ts`; update `ast` /
   `tests` / `codegraph` tier or `tech` text if change altered what language
   actually supports.
2. Run `npm run gen:lang-compat` to regenerate
   `.claude-plugin/tea-rags/rules/language-compatibility.md` and the README
   `<!-- BEGIN/END lang-compat -->` spoiler block from the descriptors.
3. Commit regenerated artifacts alongside your change.

Drift-guard test (`tests/core/domains/language/capability/drift-guard.test.ts`)
fails CI when committed files diverge from descriptors — red drift-guard = step
2 skipped.

Capability descriptor = single source of truth; rule file + README spoiler =
GENERATED views. Never hand-edit generated files — edit descriptor, regenerate.

Measured `resolveSuccessRate` is NOT a capability tier — it is per-index state
owned by `tea-rags prime`. Never bake measured numbers into a descriptor.
