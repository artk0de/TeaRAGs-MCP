# Stabilization Strategy

**When:** chunk.commitCount "extreme" + file.churnVolatility "erratic" —
high-churn, volatile code.

## Approach

- Simplify branching — reduce cyclomatic complexity
- Extract nested conditionals into named methods
- Reduce the number of code paths through the function
- Add explicit logging at decision points
- Design for testability — pure functions where possible
- If chunk.churnRatio "concentrated" — consider splitting the function
- Do not add new features on top — simplify first
- Write characterization tests before refactoring to pin existing behavior

## Why

High-churn volatile code has accumulated complexity from sequential patches.
Each patch added a condition, a fallback, a special case. The function needs
simplification, not more features layered on top.
