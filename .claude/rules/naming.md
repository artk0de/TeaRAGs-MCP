---
paths:
  - "**/*"
---

# Domain-Specific Naming (MANDATORY)

Names carry domain context — unambiguous **in isolation**, readable without
surrounding code. Prefer longer domain-qualified name over short generic
whenever generic could mean something else elsewhere in codebase.

## The Rule

Naming class/interface/type/exported object, ask: _"Seen alone — in import line,
stack trace, search result — unambiguous?"_ If generic suffix (`Outcome`,
`Strategy`, `Result`, `Context`, `Manager`, `Handler`, `Resolution`, `Metadata`,
`Info`, `Data`) forces reader to check neighbours — qualify with domain.

Generic names disambiguated only by neighbours; domain-qualified names
self-describing. Optimize for reader landing on symbol cold.

## Before / After

| Generic (rejected)      | Domain-qualified (correct)                   | Context preserved                     |
| ----------------------- | -------------------------------------------- | ------------------------------------- |
| `ResolutionOutcome`     | `SymbolResolutionOutcome`                    | a call-site→symbol resolution result  |
| `Strategy`              | `SymbolResolutionStrategy`                   | a resolution pass, not any strategy   |
| `ResolvedTarget`        | `SymbolResolutionTarget`                     | the resolved target symbol definition |
| `Metadata` / `FieldDoc` | `GitFileSignals` / `PayloadSignalDescriptor` | git trajectory signal, not meta       |
| `buildMetadata`         | `buildFileSignals`                           | builds signals, scope = file          |
| `Stats` (user-facing)   | `SignalMetrics` / `IndexMetrics`             | DTO layer, not the compute `Stats`    |

## Boundaries (don't over-qualify)

- Don't stack context enclosing module already pins down —
  `git/rerank/presets/TechDebtPreset` fine, not `GitRerankTechDebtRerankPreset`.
- Local vars + private helpers inside one small function don't need domain
  qualification — rule targets exported / cross-module names.
- Test = ambiguity at point of **use** (import, stack trace, search result), not
  point of definition.

## Cross-reference

Concrete name mappings enforced live in `CLAUDE.md` → "Naming Conventions" (e.g.
`buildFileSignals` not `buildFileMetadata`, `PayloadSignalDescriptor` not
`FieldDoc` and not a bare `Signal` — no such type exists). This rule = general
principle behind those specific cases.
