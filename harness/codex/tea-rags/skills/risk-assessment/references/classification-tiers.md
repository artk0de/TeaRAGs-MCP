# Classification Tiers

The full 14-tier risk classification table used in Phase 4 ENRICH.

| Classification          | Signature (required pair/triple)                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Coupling point**      | churn high+ AND imports high+ AND `recentAuthors` count high+                                                                  |
| **Bug attractor**       | bugFixRate concerning+ AND churn high+ AND imports low                                                                         |
| **Legacy minefield**    | ageDays legacy AND churn high+ AND bugFixRate concerning+                                                                      |
| **Fragile legacy**      | ageDays legacy AND bugFixRate concerning+ (churn typical)                                                                      |
| **Toxic silo**          | `blameDominantAuthorPct.label ∈ {silo, deep-silo}` AND bugFixRate concerning+ (OR churn high)                                  |
| **Fragile silo**        | `blameDominantAuthorPct.label ∈ {silo, deep-silo}` AND bugFixRate concerning+ AND churn typical/low AND ageDays typical/recent |
| **Healthy owner**       | `blameDominantAuthorPct.label ∈ {silo, deep-silo}` AND churn low AND ageDays legacy AND bugFixRate=healthy                     |
| **Feature-in-progress** | churn high+ AND ageDays new AND bugFixRate=healthy AND imports low                                                             |
| **Boilerplate churn**   | churn high+ AND blockPenalty high+ AND bugFixRate=healthy                                                                      |
| **Emerging coupling**   | ageDays new AND churn high+ AND imports rising                                                                                 |
| **Untested hotspot**    | No test file AND tier Critical/High                                                                                            |
| **Oversized**           | methodLines high+ (labelMap) AND in decomposition top-10                                                                       |
| **Fragile**             | volatility erratic+ AND burst high+                                                                                            |
| **Race condition**      | Agent judgment from code content                                                                                               |

Multiple classifications per candidate allowed (e.g., god module + oversized).
Healthy owner, feature-in-progress, and boilerplate churn are **NOT risks** —
report them as "benign" and exclude from risk count.

**Single strong signal?** If only one overlay signal is strong (everything else
typical/missing) → insufficient evidence. Report candidate but do not classify.
See anti-pattern #7 in signal-interpretation.md.
