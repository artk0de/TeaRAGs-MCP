---
paths:
  - "src/core/domains/language/**"
---

# Language Capability Sync (MANDATORY)

When you change a chunker hook, resolver chain, walker, or test detection for a
language under `src/core/domains/language/<lang>/`, the change may move that
language's capability tier. You MUST:

1. Re-review `src/core/domains/language/<lang>/capability.ts` and update the
   `ast` / `tests` / `codegraph` tier or `tech` text if the change altered what
   the language actually supports.
2. Run `npm run gen:lang-compat` to regenerate
   `.claude-plugin/tea-rags/rules/language-compatibility.md` and the README
   `<!-- BEGIN/END lang-compat -->` spoiler block from the descriptors.
3. Commit the regenerated artifacts alongside your change.

The drift-guard test
(`tests/core/domains/language/capability/drift-guard.test.ts`) fails CI when the
committed files diverge from the descriptors — a red drift-guard means step 2
was skipped.

The capability descriptor is the single source of truth; the rule file and the
README spoiler are GENERATED views. Never hand-edit the generated files — edit
the descriptor and regenerate.

Measured `resolveSuccessRate` is NOT a capability tier — it is per-index state
owned by `tea-rags prime`. Never bake measured numbers into a descriptor.
