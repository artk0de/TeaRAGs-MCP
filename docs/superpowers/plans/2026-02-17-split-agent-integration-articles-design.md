# Split Agent Integration Articles into L3 Sub-pages

**Date:** 2026-02-17 **Status:** Approved

## Problem

Three articles in `website/docs/agent-integration/` are too large for
comfortable reading:

| Article                            | Lines | Size    |
| ---------------------------------- | ----- | ------- |
| search-strategies.md               | 992   | 35.6 KB |
| agentic-data-driven-engineering.md | 625   | 29.1 KB |
| deep-codebase-analysis.md          | 483   | 20.1 KB |

## Solution

Split each article into a Docusaurus L3 category (subdirectory with
`_category_.json` + individual pages). Each category ends with a
`prompt-examples.md` page containing ready-to-paste AGENTS.md blocks.

Mental Model (152 lines) and Common Mistakes (328 lines) remain as single files.

## File Structure

```
agent-integration/
├── _category_.json              (existing, position: 6)
├── mental-model.md              (unchanged)
├── common-mistakes.md           (unchanged)
├── search-strategies/
│   ├── _category_.json          (position: 2, label: "Search Strategies")
│   ├── index.md                 (sidebar_position: 1)
│   ├── preset-mapping.md        (sidebar_position: 2)
│   ├── multi-tool-cascade.md    (sidebar_position: 3)
│   ├── custom-reranking.md      (sidebar_position: 4)
│   └── prompt-examples.md       (sidebar_position: 5)
├── deep-codebase-analysis/
│   ├── _category_.json          (position: 3, label: "Deep Codebase Analysis")
│   ├── index.md                 (sidebar_position: 1)
│   ├── risk-assessment.md       (sidebar_position: 2)
│   ├── ownership-and-debt.md    (sidebar_position: 3)
│   ├── impact-analysis.md       (sidebar_position: 4)
│   └── prompt-examples.md       (sidebar_position: 5)
└── agentic-data-driven/
    ├── _category_.json          (position: 4, label: "Agentic Data-Driven Engineering")
    ├── index.md                 (sidebar_position: 1)
    ├── generation-modes.md      (sidebar_position: 2)
    ├── activating.md            (sidebar_position: 3)
    └── prompt-examples.md       (sidebar_position: 4)
```

## Content Mapping

### search-strategies.md → search-strategies/

| New file                | Source H2 sections                                                                                                                                | ~Lines |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `index.md`              | The Problem + Available Tools and Their Presets                                                                                                   | ~120   |
| `preset-mapping.md`     | Agent Task to Preset Mapping (8 strategies) + Combining Filters + When to Use + Anti-Patterns + Agentic Flow Template                             | ~520   |
| `multi-tool-cascade.md` | Combining with Other Search Tools (Three-Tool Cascade + When to Use Which External Tool + Example + Decision Shortcut + Multi-Tool Anti-Patterns) | ~180   |
| `custom-reranking.md`   | Custom Rerank Strategies (4 strategies + Signal Overlap Reference + Guidelines) + Known Limitations                                               | ~200   |
| `prompt-examples.md`    | Configuring Search Strategy in AGENTS.md (Decision Tables + Ready-to-Paste Search Strategy + Ready-to-Paste Custom Reranking)                     | ~140   |

### deep-codebase-analysis.md → deep-codebase-analysis/

| New file                | Source H2 sections                                                                    | ~Lines |
| ----------------------- | ------------------------------------------------------------------------------------- | ------ |
| `index.md`              | File-Level vs Chunk-Level Metrics: When to Use Each                                   | ~50    |
| `risk-assessment.md`    | Hotspot Detection + Churn Volatility + Security Audit Surface                         | ~155   |
| `ownership-and-debt.md` | Ownership and Knowledge Silo Analysis + Tech Debt Assessment + Refactoring Candidates | ~150   |
| `impact-analysis.md`    | Blast Radius Estimation + Combining Analyses: Multi-Step Workflows                    | ~110   |
| `prompt-examples.md`    | New content: AGENTS.md prompts for deep codebase analysis workflows                   | ~100   |

### agentic-data-driven-engineering.md → agentic-data-driven/

| New file              | Source H2 sections                                                                                                            | ~Lines |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| `index.md`            | The Five Strategies                                                                                                           | ~165   |
| `generation-modes.md` | Generation Mode Switching + The Complete Generation Flow + Template Quality Score                                             | ~180   |
| `activating.md`       | Activating in Your Agent + The Transformation + See Also                                                                      | ~80    |
| `prompt-examples.md`  | All agent strategy configs (Default, Safety-First, Incident, New Feature) + Search & Generation Strategy + Code Search config | ~200   |

## prompt-examples.md Format

Each `prompt-examples.md` file follows this structure:

1. Frontmatter: `title: "Prompt Examples"`, `sidebar_position: last`
2. One-sentence intro
3. Multiple `####` sections, each with:
   - Brief description (1-2 sentences)
   - 4-backtick markdown fence with complete copy-paste AGENTS.md block
4. `:::tip` with usage recommendation

## Link Updates

- Old URLs (`/agent-integration/search-strategies`) auto-redirect to `index.md`
  in the directory (Docusaurus behavior)
- Anchor links (`#multi-tool-strategy`, `#signal-overlap-reference`) must be
  updated across all files including `common-mistakes.md` and `mental-model.md`
- Original monolithic `.md` files are deleted after directory creation

## Decisions

- **Grouping level:** Thematic (related H2 sections grouped together, not 1 H2 =
  1 page)
- **Scope:** Only 3 large articles; Mental Model and Common Mistakes stay as-is
- **Imports:** Each new page gets its own `import MermaidTeaRAGs` and
  `import AiQuery` as needed
- **Sidebar:** Autogenerated from filesystem (existing `sidebars.ts` pattern)
