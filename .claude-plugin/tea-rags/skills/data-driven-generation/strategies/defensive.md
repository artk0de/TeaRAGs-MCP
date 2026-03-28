# Defensive Strategy

**When:** chunk.bugFixRate "critical" + file.ageDays "old" or "legacy" — legacy
code with history of bugs.

## Approach

- Never delete old code — use wrapper pattern
- Add feature flags for instant rollback
- Keep old code path entirely intact as fallback
- Write comprehensive tests covering existing edge cases (study bug-fix commits
  for clues)
- Plan gradual rollout: per-user, per-tenant, or percentage-based
- Document cleanup date (remove wrapper after 30 days stable in production)
- If file.dominantAuthorPct "silo" — request review from the owner before
  merging

## Why

This code has proven that straightforward modifications break it. The defensive
wrapper pattern provides a rollback mechanism that direct editing does not.
Keeping the old path intact means production can revert instantly if the new
code misbehaves.
