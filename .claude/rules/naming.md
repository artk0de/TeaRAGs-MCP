---
paths:
  - "**/*"
---

# Domain-Specific Naming (MANDATORY)

Names must carry their domain context so they are unambiguous **in isolation** —
readable without inspecting surrounding code to disambiguate. Prefer a longer,
domain-qualified name over a short generic one whenever the generic name could
mean something else elsewhere in the codebase.

## The Rule

When naming a class, interface, type, or exported object, ask: _"If I saw this
name alone — in an import line, a stack trace, or a search result — would it be
unambiguous?"_ If a generic suffix (`Outcome`, `Strategy`, `Result`, `Context`,
`Manager`, `Handler`, `Resolution`, `Metadata`, `Info`, `Data`) would force the
reader to look at neighbours to know what it is — qualify it with the domain.

Generic names are disambiguated only by their neighbours; domain-qualified names
are self-describing. Optimize for the reader who lands on the symbol cold.

## Before / After

| Generic (rejected)      | Domain-qualified (correct)       | Context preserved                     |
| ----------------------- | -------------------------------- | ------------------------------------- |
| `ResolutionOutcome`     | `SymbolResolutionOutcome`        | a call-site→symbol resolution result  |
| `Strategy`              | `SymbolResolutionStrategy`       | a resolution pass, not any strategy   |
| `ResolvedTarget`        | `SymbolResolutionTarget`         | the resolved target symbol definition |
| `Metadata` / `FieldDoc` | `GitFileSignals` / `Signal`      | git trajectory signal, not meta       |
| `buildMetadata`         | `buildFileSignals`               | builds signals, scope = file          |
| `Stats` (user-facing)   | `SignalMetrics` / `IndexMetrics` | DTO layer, not the compute `Stats`    |

## Boundaries (don't over-qualify)

- Don't stack context the enclosing module already pins down —
  `git/rerank/presets/TechDebtPreset` is fine, not
  `GitRerankTechDebtRerankPreset`.
- Local variables and private helpers inside one small function don't need
  domain qualification — the rule targets exported / cross-module names.
- The test is ambiguity at the point of **use** (import, stack trace, search
  result), not at the point of definition.

## Cross-reference

Concrete name mappings already enforced live in `CLAUDE.md` → "Naming
Conventions" (e.g. `buildFileSignals` not `buildFileMetadata`, `Signal` not
`FieldDoc`). This rule is the general principle behind those specific cases.
