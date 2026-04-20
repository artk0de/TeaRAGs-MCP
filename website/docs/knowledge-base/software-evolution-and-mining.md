---
title: "Software Evolution & Mining"
sidebar_position: 3
---

# Software Evolution & Mining Software Repositories

Software systems don't stay still. They grow, decay, get reshaped by teams, accumulate technical debt, and occasionally get rewritten. **Software evolution** is the discipline that studies those dynamics; **Mining Software Repositories (MSR)** is the branch that treats version-control histories, issue trackers, and code reviews as data to extract quantitative insight.

TeaRAGs leans heavily on MSR results — nearly every git-derived signal it attaches to code chunks is operationalized from a published finding. This page surveys the foundational work and explains which signals come from where.

---

## Laws of Software Evolution (Lehman)

Meir Lehman's work in the 1970s–80s established software evolution as a studied phenomenon rather than a collection of anecdotes.

- **Lehman, M.M. (1980). ["Programs, Life Cycles, and Laws of Software Evolution."](https://doi.org/10.1109/PROC.1980.11805) *Proceedings of the IEEE*.** Introduced the distinction between S-type (specifiable), P-type (problem-solving), and E-type (embedded in real-world context) software — and the observation that E-type software **must evolve** or lose utility.
- **Lehman, M.M. & Ramil, J.F. (2001). ["Rules and Tools for Software Evolution Planning and Management."](https://doi.org/10.1023/A:1011535226758) *Annals of Software Engineering*.** Consolidation of the eight laws:
  1. **Continuing Change** — E-type systems must be continually adapted
  2. **Increasing Complexity** — without deliberate effort, complexity grows
  3. **Self-Regulation** — the process of evolution is self-regulating
  4. **Conservation of Organisational Stability** — global activity rate tends to constant
  5. **Conservation of Familiarity** — per-release change must stay familiar
  6. **Continuing Growth** — functional content grows to maintain satisfaction
  7. **Declining Quality** — quality declines unless actively maintained
  8. **Feedback System** — evolution is a multi-loop, multi-level feedback system

Laws 2 and 7 are the theoretical grounding for trajectory-enrichment awareness: if complexity and decay accumulate by default, **passively ranking by similarity will eventually surface the accumulated cruft as "relevant"**. You need a signal that distinguishes "code that's here because it was written well" from "code that's here because it keeps being patched".

---

## Mining Software Repositories — Foundations

The MSR conference series started in 2004. A few papers define the field:

### Code churn as a predictor

- **Nagappan, N. & Ball, T. (2005). ["Use of Relative Code Churn Measures to Predict System Defect Density."](https://www.microsoft.com/en-us/research/publication/use-of-relative-code-churn-measures-to-predict-system-defect-density/) *ICSE*.** The canonical result: **relative churn** (lines changed / total lines) is a better defect predictor than absolute churn. Basis for TeaRAGs' `relativeChurn` signal and its prominence in `techDebt` / `hotspots` presets. See [Code Churn Research](/knowledge-base/code-churn-research) for the full treatment.
- **Moser, R., Pedrycz, W. & Succi, G. (2008). ["A Comparative Analysis of the Efficiency of Change Metrics and Static Code Attributes for Defect Prediction."](https://doi.org/10.1145/1368088.1368114) *ICSE*.** Change metrics out-perform static code attributes for defect prediction. Confirms the value of mining history over purely structural features.

### Ownership and bug-proneness

- **Bird, C., Nagappan, N., Murphy, B., Gall, H. & Devanbu, P. (2011). ["Don't Touch My Code! Examining the Effects of Ownership on Software Quality."](https://www.microsoft.com/en-us/research/publication/dont-touch-my-code-examining-the-effects-of-ownership-on-software-quality/) *ESEC/FSE*.** Concentrated ownership → fewer post-release failures. Minor contributors (one or two commits) correlate with more bugs than dominant maintainers. Motivates TeaRAGs' `dominantAuthorPct` and `knowledgeSilo` signals.
- **Rahman, F. & Devanbu, P. (2011). ["Ownership, Experience and Defects: A Fine-Grained Study of Authorship."](https://doi.org/10.1145/1985793.1985860) *ICSE*.** Experience of the author with the specific file matters, not just general tenure. Informs the distinction between dominant-author and author-diversity signals.
- **Mockus, A. (2010). ["Organizational Volatility and Its Effects on Software Defects."](https://doi.org/10.1145/1882291.1882311) *FSE*.** Organisational churn (contributor turnover) amplifies technical debt accumulation.

### Hotspot detection

- **Tornhill, A. (2015, 2024). *Your Code as a Crime Scene* (Pragmatic Bookshelf).** Popularised the "hotspot" model: files with both high complexity and high change frequency are disproportionately the source of bugs. The `hotspots` preset in TeaRAGs implements this pattern in weight form.
- **D'Ambros, M., Lanza, M. & Robbes, R. (2010). ["An Extensive Comparison of Bug Prediction Approaches."](https://doi.org/10.1109/MSR.2010.5463279) *MSR*.** Systematic comparison showing the strongest predictors are usually combinations of change metrics, not any single feature.

### Evolutionary coupling

- **Gall, H., Hajek, K. & Jazayeri, M. (1998). ["Detection of Logical Coupling Based on Product Release History."](https://doi.org/10.1109/ICSM.1998.738508) *ICSM*.** Files that change together are "logically coupled" — even if no static dependency links them. Precursor to impact-analysis presets.
- **Zimmermann, T., Weißgerber, P., Diehl, S. & Zeller, A. (2004). ["Mining Version Histories to Guide Software Changes."](https://doi.org/10.1109/TSE.2005.72) *TSE*.** Association-rule mining over commit histories → "when you change A, you'll likely need to change B". Future work for TeaRAGs' reranking.

### Bug-fix classification

- **Mockus, A. & Votta, L.G. (2000). ["Identifying Reasons for Software Changes Using Historic Databases."](https://doi.org/10.1109/ICSM.2000.883028) *ICSM*.** Classifying commits into categories (corrective, adaptive, perfective, preventive). Textual heuristics on commit messages reliably identify bug fixes. Basis for TeaRAGs' `bugFixRate` signal.
- **Śliwerski, J., Zimmermann, T. & Zeller, A. (2005). ["When Do Changes Induce Fixes?"](https://doi.org/10.1145/1083142.1083147) *MSR*.** The SZZ algorithm — trace a fix commit back to the bug-introducing commit. More sophisticated than keyword classification; not currently used in TeaRAGs but sometimes applied in research settings.

---

## From Research to Signals

The mapping from the literature to what TeaRAGs stores:

| Research finding | TeaRAGs signal | Where stored |
|------------------|----------------|--------------|
| Nagappan & Ball 2005 (relative churn) | `git.file.relativeChurn`, `git.chunk.relativeChurn` | [Data Model](/architecture/data-model) |
| Bird et al. 2011 (concentrated ownership helps) | `git.file.dominantAuthorPct`, `git.file.contributorCount` | Data Model |
| Rahman & Devanbu 2011 (experience matters) | Derived `ownership` signal | Rerank |
| Mockus & Votta 2000 (bug-fix keyword classification) | `git.file.bugFixRate`, `git.chunk.bugFixRate` | Data Model |
| Tornhill 2015 (churn × complexity hotspots) | `hotspots` preset | [Rerank presets](/usage/advanced/rerank-presets) |
| Lehman Law 7 (decline unless maintained) | Composite `techDebt` preset | Rerank presets |

**Relative churn is the load-bearing citation.** More than any single other finding, Nagappan & Ball 2005 is the reason TeaRAGs exists. If you read one paper from this list, read that one.

---

## Commit-History Assumptions That Don't Always Hold

The research above assumes **human-authored commits at logical granularity**. Agent-assisted development breaks this assumption — agents commit in micro-increments, inflating every commit-count-based metric. TeaRAGs addresses this with [GIT SESSIONS](/architecture/git-enrichment-pipeline#git-sessions) (`TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true`) which groups bursts of commits into sessions.

See [Agent-Augmented Development](/knowledge-base/agent-augmented-development) for the research on how AI assistance changes repository mining. The short version: the signals still work, but they need to be computed on sessions rather than raw commits.

---

## Further Reading

### Textbooks

- Mens, T. & Demeyer, S. (eds.) (2008). *Software Evolution*. Springer. The canonical academic treatment.
- Tornhill, A. (2024). *Your Code as a Crime Scene* (2nd ed.). Pragmatic Bookshelf. Practitioner-facing; bridges research and tooling.

### Venues

- **MSR (International Conference on Mining Software Repositories)** — the primary venue for this research
- **ICSE, ESEC/FSE, ASE** — broader software engineering conferences with strong MSR tracks
- **TSE, TOSEM** — journals for longer-form evolution research

### Inside this knowledge base

- [Code Churn Research](/knowledge-base/code-churn-research) — detailed treatment of churn, bug-fix rate, relative vs absolute
- [Code Quality Metrics](/knowledge-base/code-quality-metrics) — coupling, complexity, composite risk metrics
- [Signal Scoring Methods](/knowledge-base/signal-scoring-methods) — how these research findings become weighted scoring functions
- [Agent-Augmented Development](/knowledge-base/agent-augmented-development) — what changes when a chunk of commits is AI-generated
