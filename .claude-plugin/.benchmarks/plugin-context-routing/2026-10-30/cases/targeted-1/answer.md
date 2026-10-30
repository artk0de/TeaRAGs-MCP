For a requested limit of **10**, the planner chooses **40 candidates**. For large limits, the maximum is **160**.

The formula is `min(max(limit × 4, 32), 160)` in [planner.ts](/Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/plugin-routing-evals/runs/20261030-182853-286087000/cases/targeted-1/workspace/src/retrieval/planner.ts:42).
