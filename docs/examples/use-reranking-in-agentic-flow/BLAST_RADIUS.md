# Blast Radius Metrics: Theory, Research, and Implementation

## Abstract

Blast radius quantifies the potential impact of changing a code entity — how many other parts of the system will be affected. This document surveys the academic foundations, industrial systems, and practical implementation strategies for blast radius and related change-impact metrics in the context of code intelligence tools.

## 1. Foundations: Coupling and Dependency Metrics

### 1.1. Fan-In / Fan-Out (Henry & Kafura 1981)

The original information flow metrics defined by Henry and Kafura measure:

- **Fan-In** — number of modules that call or depend on a given module
- **Fan-Out** — number of modules that a given module calls or depends on

At the file level, these map to import/dependency relationships:

- **Structural Fan-In (SFIN)** = count of files that import this file
- **Structural Fan-Out (SFOUT)** = count of files this file imports

A longitudinal study of fan-in and fan-out in open-source systems (Counsell et al.) established that:

- Fan-in follows a **power-law distribution** — a few files are critically important
- Fan-out follows a **log-normal distribution** — most files have moderate dependencies
- Refactored classes tend to have larger fan-in and fan-out values

**References:**
- Henry, S. & Kafura, D. (1981). "Software Structure Metrics Based on Information Flow." IEEE TSE.
- Counsell, S. et al. (2010). "An Evolutionary Study of Fan-in and Fan-out Metrics in OSS." IEEE CSMR.
- Counsell, S. et al. (2011). "A Longitudinal Study of Fan-In and Fan-Out Coupling in Open-Source Systems."

### 1.2. Robert Martin's Package Metrics (2002)

Robert C. Martin formalized package-level coupling metrics in "Agile Software Development: Principles, Patterns, and Practices":

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| **Ca** (Afferent Coupling) | Count of external classes depending on this package | Responsibility — who needs me |
| **Ce** (Efferent Coupling) | Count of external classes this package depends on | Dependency — who I need |
| **Instability (I)** | `Ce / (Ce + Ca)` | 0 = maximally stable, 1 = maximally unstable |
| **Abstractness (A)** | abstract classes / total classes | 0 = concrete, 1 = abstract |
| **Distance (D)** | `\|A + I - 1\|` | Distance from the "main sequence" ideal |

The **Stable Dependencies Principle** states: depend in the direction of stability (low I). High fan-in modules should be stable (low I) and abstract (high A).

**Key insight for blast radius:** Instability `I = Ce / (Ce + Ca)` elegantly combines fan-in and fan-out into a single metric. Modules with low instability (high fan-in relative to fan-out) have the largest blast radius.

**References:**
- Martin, R.C. (2002). "Agile Software Development: Principles, Patterns, and Practices." Prentice Hall.
- Almugrin, S. & Melton, A. (2015). "A Validation of Martin's Metric." Journal of Object Technology.

### 1.3. Graph-Theoretic Metrics

When the entire dependency graph is available, network analysis metrics apply:

| Metric | What it measures | Relevance to blast radius |
|--------|------------------|---------------------------|
| **In-Degree** | Direct dependents (= fan-in) | First-order blast radius |
| **Betweenness Centrality** | Frequency as a bridge between shortest paths | "Gatekeeper" files — changing them disrupts information flow |
| **PageRank** | Importance weighted by quality of incoming links | Files depended on by important files are more important |
| **Closeness Centrality** | Average distance to all other nodes | Files close to everything propagate changes widely |

He (2013) applied centrality metrics to Java software dependency networks and found a statistically significant relationship between a class's graph importance (degree, PageRank, HITS) and bug-proneness.

The node2defect approach (ASE 2018) used network embedding on dependency graphs to predict defects, outperforming traditional metrics alone.

**References:**
- He, Z. et al. (2013). "Using Software Dependency to Bug Prediction." Mathematical Problems in Engineering.
- Qu, Y. et al. (2018). "node2defect: Using Network Embedding to Improve Software Defect Prediction." ASE 2018.
- Zimmermann, T. & Nagappan, N. (2008). "Predicting Defects Using Network Analysis on Dependency Graphs." ICSE 2008.

## 2. Churn × Complexity: The Hotspot Model

### 2.1. Hotspot Analysis (Tornhill 2013–2024)

Adam Tornhill's "Your Code as a Crime Scene" methodology, implemented in CodeScene, defines hotspots as:

> **Hotspot = High Complexity × High Change Frequency**

The key insight: complexity only matters if you need to deal with it frequently. A 500-line function that never changes is not a problem. A 50-line function that changes every week is.

**Empirical validation:** In a case study of 400 KLOC with 89 developers and 18,000+ commits, hotspot analysis identified 7 of 8 most defect-dense modules. **4% of code was responsible for 72% of all defects.**

**References:**
- Tornhill, A. (2015). "Your Code as a Crime Scene." Pragmatic Bookshelf.
- Tornhill, A. (2024). "Your Code as a Crime Scene, Second Edition." Pragmatic Bookshelf.

### 2.2. Temporal Coupling (CodeScene)

Beyond direct import dependencies, CodeScene measures **temporal coupling** — files that change together in commits:

- Two files that consistently appear in the same commits have high temporal coupling
- This reveals hidden dependencies not visible in import graphs
- Use cases: detecting copy-paste code, evaluating test relevance, finding architectural decay

**Filter:** Commits touching >50 files are excluded (reorganizations create false positives).

**References:**
- CodeScene Documentation. "Temporal Coupling." docs.enterprise.codescene.io.

### 2.3. Relative Code Churn (Nagappan & Ball, Microsoft, ICSE 2005)

The foundational Microsoft Research study on Windows Server 2003 demonstrated that **relative** churn measures are far superior to absolute ones:

| Metric | Formula | Absolute? |
|--------|---------|-----------|
| ChurnedLOC / TotalLOC | changed lines / file size | Relative ✓ |
| ChurnCount / FileCount | churns / files in component | Relative ✓ |
| ChurnedLOC / ChurnCount | lines per churn | Relative ✓ |

Results: relative code churn predicted defect density with **89% accuracy** on Windows Server 2003 binaries.

**References:**
- Nagappan, N. & Ball, T. (2005). "Use of Relative Code Churn Measures to Predict System Defect Density." ICSE 2005, pp. 284–292.

## 3. Composite Risk Metrics

### 3.1. CRAP: Change Risk Anti-Patterns

The CRAP metric combines cyclomatic complexity with test coverage:

```
CRAP(m) = comp(m)² × (1 - cov(m)/100)³ + comp(m)
```

| Complexity | Required coverage for CRAP < 30 |
|------------|-------------------------------|
| 5 | 0% |
| 10 | 42% |
| 25 | 80% |
| 30+ | Impossible — must reduce complexity |

CRAP threshold of 30 was empirically chosen. Below 30 = low maintenance risk. Above 30 = "crappy" code.

**References:**
- Crap4j Project. crap4j.org. "The Code C.R.A.P. Metric Hits the Fan."
- NDepend Blog. "CRAP Metric Is a Thing And It Tells You About Risk in Your Code."

### 3.2. SonarQube Technical Debt Model

SonarQube defines technical debt as remediation cost (in minutes) and rates maintainability:

| Rating | Debt Ratio | Interpretation |
|--------|-----------|----------------|
| A | 0–5% | Minimal debt |
| B | 6–10% | Manageable |
| C | 11–20% | Attention needed |
| D | 21–50% | Significant |
| E | 50%+ | Critical |

SonarQube measures both **cyclomatic complexity** (path count) and **cognitive complexity** (human readability). These are complementary: cyclomatic measures testability, cognitive measures comprehensibility.

**References:**
- SonarSource. "Understanding Measures and Metrics." docs.sonarsource.com.

### 3.3. Defect Prediction via Combined Metrics

Large-scale empirical studies consistently show that combining metric categories outperforms single-category models:

| Metric Category | Examples | Predictive Power (alone) |
|----------------|----------|-------------------------|
| Process metrics | churn, change frequency, author count | High |
| Code metrics | complexity, LOC, coupling | Medium-High |
| Network metrics | fan-in, centrality, PageRank | Medium |
| Combined | all of the above | **Highest** |

Nagappan & Ball (Microsoft) demonstrated that software dependencies and churn measures together are efficient predictors of post-release failures.

CCC metrics (coupling, cohesion, complexity) were shown to correlate with security vulnerabilities in Mozilla Firefox at statistically significant levels.

**References:**
- Nagappan, N. & Ball, T. (2007). "Using Software Dependencies and Churn Metrics to Predict Field Failures." ISSRE 2007.
- Shin, Y. et al. (2010). "Can Complexity, Coupling, and Cohesion Metrics Be Used as Early Indicators of Vulnerabilities?" ACM SAC 2010.
- Rebrö, D.A. (2023). "Source Code Metrics for Software Defects Prediction." arXiv:2301.08022.

## 4. Industrial Systems

### 4.1. CodeScene

The most mature blast-radius-aware system. Combines:
- Hotspot analysis (complexity × change frequency)
- Temporal coupling (co-change analysis)
- X-Ray (method-level temporal coupling within hotspots)
- Code health scoring (nesting, function length, coupling)

Does **not** compute structural fan-in/fan-out from imports. Relies on temporal coupling as a proxy for hidden dependencies.

### 4.2. SonarQube

Focuses on static analysis: complexity, code smells, duplications, test coverage. Does **not** incorporate git history, churn, or dependency graphs. Maintainability rating is based on remediation cost, not change risk.

### 4.3. Google (Tricorder + ML Code Review)

Google's internal tools process millions of code review comments per year. ML models predict needed code edits from reviewer comments. Risk assessment is implicit in the review process — trained on change history, code complexity, and developer activity.

### 4.4. NDepend / JArchitect

Static analysis tools that implement Martin's metrics (Ca, Ce, Instability, Abstractness, Distance from Main Sequence) and compute dependency graphs with fan-in/fan-out at method, class, and namespace levels.

## 5. Metric Tiers for tea-rags Implementation

### Tier 1: Core (highest ROI, implement first)

| Metric | Signal | Source | Rationale |
|--------|--------|--------|-----------|
| **importedByCount** | `importedBy` | Reverse dependency scan | Direct blast radius. Power-law = few files dominate. |
| **Instability** | `instability` | `Ce / (Ce + Ca)` | Martin's metric. Single number combining fan-in + fan-out. |
| **isHub** | `isHub` | `fanIn > θ₁ AND fanOut > θ₂` | Hub files = maximum change risk. Boolean flag. |
| **Cyclomatic Complexity** | `complexity` | tree-sitter AST | Foundation for hotspot model. Every study uses it. |
| **Composite Hotspot** | (preset) | `churn × complexity` | CodeScene proved: 4% code = 72% defects. |

### Tier 2: Recommended (strong research backing)

| Metric | Signal | Source | Rationale |
|--------|--------|--------|-----------|
| **Cognitive Complexity** | `cognitive` | tree-sitter AST | SonarQube: better than cyclomatic for readability. |
| **Change Risk Score** | (preset) | `churn × complexity × blastRadius` | Composite of all three dimensions. |
| **isLeaf** | `isLeaf` | `fanIn = 0 AND fanOut ≥ 1` | Leaf nodes are safe to change (no dependents). |
| **fanOut** | `fanOut` | `imports.length` (already exists) | Efferent coupling — dependency on externalities. |

### Tier 3: Situational (useful in specific contexts)

| Metric | When useful | Why not Tier 1 |
|--------|-------------|----------------|
| **Temporal Coupling** | Hidden dependency detection, copy-paste | Requires co-change analysis pipeline |
| **Betweenness Centrality** | Architectural "bridge" detection | Requires full graph + graph algorithms |
| **PageRank** | "Importance" with quality weighting | Overkill for file-level analysis |
| **Distance from Main Sequence** | Package health checks | Requires abstractness data |
| **CRAP Score** | Risk = complexity × (1 - coverage) | No test coverage data available |
| **Transitive Fan-In** | Cascading blast radius (N levels deep) | Exponential computation cost |

## 6. Proposed Reranker Signals (New)

Building on the existing 17 signals in the tea-rags reranker:

```typescript
// New signals (Tier 1-2)
importedBy:    normalize(deps.importedByCount, maxImportedBy)   // fan-in
fanOut:        normalize(imports.length, maxFanOut)              // fan-out (using existing data)
isHub:         deps.isHub ? 1.0 : 0                             // high fan-in AND high fan-out
instability:   deps.instability                                 // Ce/(Ce+Ca), already 0-1
complexity:    normalize(complexity.cyclomatic, maxComplexity)   // future: from AST
```

### New Presets

```typescript
blastRadius: {
  similarity:  0.30,
  importedBy:  0.25,  // fan-in = direct blast radius
  fanOut:      0.15,  // efferent coupling
  isHub:       0.15,  // hub flag = max risk
  churn:       0.15,  // existing churn signal
}

changeRisk: {
  similarity:  0.20,
  churn:       0.15,
  importedBy:  0.15,  // blast radius dimension
  complexity:  0.15,  // complexity dimension (when available)
  bugFix:      0.10,
  volatility:  0.10,
  knowledgeSilo: 0.10,
  burstActivity: 0.05,
}
```

Updated `impactAnalysis` (currently `similarity: 0.5, imports: 0.5`):

```typescript
impactAnalysis: {
  similarity:  0.30,
  importedBy:  0.30,  // was: imports 0.5 (fan-out only)
  fanOut:      0.15,
  isHub:       0.15,
  churn:       0.10,
}
```

## 7. Payload Schema Extension

```typescript
// New top-level payload field: deps
interface DepsPayload {
  importedByCount: number;   // structural fan-in
  importedBy?: string[];     // list of importing file paths (optional, can be large)
  fanOut: number;            // = imports.length
  isHub: boolean;            // importedByCount > θ₁ AND fanOut > θ₂
  isLeaf: boolean;           // importedByCount = 0 AND fanOut ≥ 1
  instability: number;       // Ce / (Ce + Ca), range 0-1
}

// Future: complexity payload
interface ComplexityPayload {
  cyclomatic: number;        // McCabe complexity
  cognitive: number;         // SonarQube cognitive complexity
}
```

## 8. Implementation Phases

### Phase A: AST Import Extraction (tea-rags-mcp-84f)

Replace regex-based import extraction with tree-sitter AST parsing. Expand language support beyond JS/TS/Python. Extract structured `ImportEntry` objects with kind classification (named, default, namespace, side-effect).

### Phase B: importedBy Computation (tea-rags-mcp-74o)

Post-indexing pass: build reverse dependency map from existing `imports[]` data. Store `deps.*` payload via `batchSetPayload`. Compute instability, isHub, isLeaf.

### Phase C: blastRadius Preset (tea-rags-mcp-g5n)

Wire new signals into the reranker. Add `blastRadius` and update `impactAnalysis` preset. Add normalization bounds.

### Phase D: Complexity Metrics (tea-rags-mcp-nyg)

Compute cyclomatic and cognitive complexity from tree-sitter AST. Store in `complexity.*` payload. Add reranker signal.

### Phase E: Change Risk Score (tea-rags-mcp-pia)

Composite preset combining all three dimensions: churn, blast radius, complexity.

## References

1. Henry, S. & Kafura, D. (1981). "Software Structure Metrics Based on Information Flow." IEEE TSE, 7(5), 510–518.
2. Martin, R.C. (2002). "Agile Software Development: Principles, Patterns, and Practices." Prentice Hall.
3. Nagappan, N. & Ball, T. (2005). "Use of Relative Code Churn Measures to Predict System Defect Density." ICSE 2005, 284–292.
4. Nagappan, N. & Ball, T. (2007). "Using Software Dependencies and Churn Metrics to Predict Field Failures." ISSRE 2007.
5. Zimmermann, T. & Nagappan, N. (2008). "Predicting Defects Using Network Analysis on Dependency Graphs." ICSE 2008.
6. Hassan, A.E. (2009). "Predicting Faults Using the Complexity of Code Changes." ICSE 2009.
7. Shin, Y. et al. (2010). "Can Complexity, Coupling, and Cohesion Metrics Be Used as Early Indicators of Vulnerabilities?" ACM SAC 2010.
8. Counsell, S. et al. (2010). "An Evolutionary Study of Fan-in and Fan-out Metrics in OSS." IEEE CSMR.
9. He, Z. et al. (2013). "Using Software Dependency to Bug Prediction." Mathematical Problems in Engineering.
10. Tornhill, A. (2015). "Your Code as a Crime Scene." Pragmatic Bookshelf.
11. Qu, Y. et al. (2018). "node2defect: Using Network Embedding to Improve Software Defect Prediction." ASE 2018.
12. Rebrö, D.A. (2023). "Source Code Metrics for Software Defects Prediction." arXiv:2301.08022.
13. Tornhill, A. (2024). "Your Code as a Crime Scene, Second Edition." Pragmatic Bookshelf.
