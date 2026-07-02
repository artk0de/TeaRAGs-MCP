---
paths:
  - "website/docs/**/*.md"
---

# Documentation Rules (Docusaurus)

## Mermaid Diagram Style

Creating/modifying Mermaid diagrams in Docusaurus docs (`website/docs/**/*.md`)
→ ALWAYS follow TeaRAGs style:

### Required Syntax

1. **Use `<MermaidTeaRAGs>` component** — NOT plain markdown code blocks
   - Import at top of file:
     `import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';`
   - Wrap diagram in component with template literal syntax
2. **Use `flowchart LR`** — NOT `graph LR`, `graph TD`, or other variants
3. **Add emojis** to node labels for visual appeal
4. **Use `<small>` tags** for subtitles/descriptions in nodes
5. **Use subgraphs** for logical grouping when needed
6. **NO custom styles** — do NOT add `style`, `fill`, `color`, or `classDef`
   lines
   - All styling is handled by the MermaidTeaRAGs component

### Canonical Example

**At top of .md file:**

```markdown
import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';
```

**In document body:**

```jsx
<MermaidTeaRAGs>
  {`
flowchart LR
    User[👤 User]

    subgraph mcp["TeaRAGs MCP Server"]
        Agent[🤖 Agent<br/><small>orchestrates</small>]
        TeaRAGs[🍵 TeaRAGs<br/><small>search · enrich · rerank</small>]
        Agent <--> TeaRAGs
    end

    Qdrant[(🗄️ Qdrant<br/><small>vector DB</small>)]
    Embeddings[✨ Embeddings<br/><small>Ollama/OpenAI</small>]
    Codebase[📁 Codebase<br/><small>+ Git History</small>]

    User <--> Agent
    TeaRAGs <--> Qdrant
    TeaRAGs <--> Embeddings
    TeaRAGs <--> Codebase
`}
</MermaidTeaRAGs>
```

### Common Emojis for Diagrams

| Component        | Emoji |
| ---------------- | ----- |
| User             | 👤    |
| Agent            | 🤖    |
| TeaRAGs          | 🍵    |
| Database/Storage | 🗄️    |
| Embeddings/AI    | ✨    |
| Codebase/Files   | 📁    |
| Server/Machine   | 🖥️ 💻 |
| Network/API      | 🌐    |
| Git/VCS          | 🔀    |
| Search           | 🔍    |

### Reference

Canonical TeaRAGs diagram style: `website/docs/index.md` (main page).

## AI Query Blocks

Showing example prompts/queries a user asks an AI agent → use `<AiQuery>`
component, NOT plain markdown blockquotes (`>`).

### Required Syntax

1. **Use `<AiQuery>` component** — NOT `>` blockquotes
   - Import at top of file:
     `import AiQuery from '@site/src/components/AiQuery';`
   - One component per query
2. **No quotes** around the text — the component handles styling
3. Renders as monospace-font blockquote with golden gradient border

### Canonical Example

**At top of .md file:**

```markdown
import AiQuery from '@site/src/components/AiQuery';
```

**In document body:**

```jsx
<AiQuery>How does authentication work in this project?</AiQuery>
<AiQuery>Find where we handle payment errors</AiQuery>
<AiQuery>Show me the database connection logic</AiQuery>
```

### When to use

- Example queries to an AI assistant / agent
- Prompt examples in documentation
- Any "ask your agent" style content

### When NOT to use

- Regular blockquotes (use standard `>` markdown)
- Code examples (use ` ``` ` code blocks)
- Admonitions (use `:::tip`, `:::warning`, etc.)

### Reference

Canonical usage: `website/docs/quickstart/first-query.md`.

## Signal Naming Glossary

TeaRAGs returns git signals at two levels. Docs MUST use correct level
consistently.

### Chunk-level signals (function/block granularity)

Use in threshold/decision tables, generation-mode conditions, any context
evaluating a specific function/code block:

| Signal             | Description                                       |
| ------------------ | ------------------------------------------------- |
| `chunkBugFixRate`  | % of commits that are bug fixes for this chunk    |
| `chunkCommitCount` | Total commits that touched this chunk             |
| `chunkAgeDays`     | Days since this chunk was last modified           |
| `chunkChurnRatio`  | Fraction of file's churn this chunk absorbs (0–1) |
| `chunkTaskIds`     | Ticket IDs from commits touching this chunk       |

### File-level signals

Use for ownership analysis, blast radius (imports), filters, file-wide
assessments:

| Signal                    | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `bugFixRate`              | % of commits that are bug fixes for the file                  |
| `commitCount`             | Total commits to the file                                     |
| `ageDays`                 | Days since last modification of the file                      |
| `recentDominantAuthorPct` | % of recent-window commits by the top recent committer        |
| `recentContributorCount`  | Unique recent committers for the file (commit-based)          |
| `blameDominantAuthorPct`  | % of currently-living lines owned by the top live-line author |
| `blameContributorCount`   | Unique live-line owners (from `git blame HEAD`)               |
| `relativeChurn`           | Lines changed / total lines                                   |
| `churnVolatility`         | Standard deviation of commit sizes                            |
| `imports`                 | Number of file-level imports (blast radius)                   |

Two ownership families answer different questions:

- `recent*` — _who's been committing here lately?_ Review routing, activity
  hotspots, feature-in-progress detection.
- `blame*` — _who currently owns the live lines?_ Authority, knowledge silos,
  bus factor.

Long-time owner stops contributing → `blame*` keeps showing them (lines remain),
`recent*` highlights newer committers.

### Rerank weight keys (API parameter names)

Literal keys for `rerank: { "custom": { ... } }`. Differ from signal names:

| Weight key                    | Maps to signal                                               |
| ----------------------------- | ------------------------------------------------------------ |
| `bugFix`                      | `chunkBugFixRate`                                            |
| `chunkChurn`                  | `chunkCommitCount`                                           |
| `chunkRelativeChurn`          | `chunkChurnRatio`                                            |
| `age`                         | `ageDays`                                                    |
| `recency`                     | inverse `ageDays`                                            |
| `stability`                   | inverse `commitCount`                                        |
| `churn`                       | `commitCount`                                                |
| `ownership`                   | `blameDominantAuthorPct` + `blameAuthors` (live-line family) |
| `knowledgeSilo`               | single live-line owner (binary, blame family)                |
| `recentActivityConcentration` | `recentDominantAuthorPct` + `recentAuthors` (commit-window)  |
| `volatility`                  | `churnVolatility`                                            |
| `imports`                     | `imports` count                                              |
| `similarity`                  | embedding similarity                                         |

### Naming rules

1. **Never mix levels** — discussing a function → use `chunkBugFixRate`, not
   `bugFixRate`
2. **Threshold tables** always use chunk-level signals (evaluate individual code
   blocks)
3. **Ownership/blast radius** use file-level signals (`blameDominantAuthorPct`
   ownership, `recentDominantAuthorPct` activity, `imports` blast radius)
4. **Qdrant filter paths** use `git.` prefix: `git.ageDays`, `git.commitCount`,
   `git.file.blameDominantAuthor`, `git.file.recentDominantAuthor`
5. **Threshold column headers** always: **Safe / Caution / Stop** (not
   Warning/Critical, not Accept/Flag/Block)
6. **Hardcoded percentile thresholds** (e.g. "dominantAuthorPct ≥ 95%")
   forbidden in docs. Use adaptive labels: `shared` / `concentrated` / `silo` /
   `deep-silo` for `*DominantAuthorPct`; `solo` / `pair` / `team` / `crowd` for
   `*ContributorCount`. Labels from per-codebase percentiles via
   `get_index_metrics`.

## Table Styling

Table headers auto-get golden styling via CSS (`website/src/css/custom.css`).

No custom styles / HTML — just standard Markdown tables:

```markdown
| Column 1 | Column 2 |
| -------- | -------- |
| Data     | Data     |
```

Headers auto-render with:

- Golden gradient background
- Golden text color (theme-aware)
- Golden bottom border
