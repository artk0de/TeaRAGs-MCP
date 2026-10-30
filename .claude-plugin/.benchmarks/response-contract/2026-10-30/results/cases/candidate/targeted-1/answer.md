For a requested limit of **10**, the planner chooses **40 candidates**. The maximum is **160 candidates**, reached at limits of 40 or higher.

The formula is `min(max(limit × 4, 32), 160)` in [planner.ts](src/retrieval/planner.ts#L42).
