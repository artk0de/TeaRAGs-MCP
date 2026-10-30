For a requested limit of **10**, the planner chooses **40 candidates**. The maximum is **160**, reached when the requested limit is 40 or higher.

The formula is `min(max(limit * 4, 32), 160)` in [planner.ts](/Users/artk0re/Dev/Tools/tea-rags-mcp/.tmp/plugin-routing-evals/response-contract-runs/20261030-184546-954844000/control/cases/targeted-1/workspace/src/retrieval/planner.ts:42).
