# Typed Errors (MANDATORY)

All runtime errors MUST use concrete error classes from the unified hierarchy.

## Rules

1. **NEVER `throw new Error("message")`** — always use a concrete error class
   from the hierarchy defined in `src/core/contracts/errors.ts`.

2. **Adapters catch raw errors and throw typed errors.** External API messages
   go in `cause`, not in the typed error's `message`.

3. **Domains throw domain-specific errors.** Each domain has its own abstract
   base class (`IngestError`, `ExploreError`, `TrajectoryError`).

4. **Facades validate input** and throw `InputValidationError` subclasses before
   calling infrastructure code.

5. **Programming errors are the only exception.** Invariant violations (e.g.
   "Pipeline not started", "Shard count must be at least 1") may use plain
   `Error` — they indicate caller bugs, not user-facing issues.

6. **MCP tool handlers NEVER contain try/catch.** All error handling is
   centralized in `errorHandlerMiddleware` via `registerToolSafe`.

## Error Hierarchy

```
TeaRagsError (abstract)                    src/core/infra/errors.ts
  ├─ UnknownError                          src/core/infra/errors.ts
  ├─ InputValidationError (abstract)       src/core/api/errors.ts
  ├─ InfraError (abstract)                 src/core/adapters/errors.ts
  ├─ IngestError (abstract)                src/core/domains/ingest/errors.ts
  ├─ ExploreError (abstract)               src/core/domains/explore/errors.ts
  ├─ TrajectoryError (abstract)            src/core/domains/trajectory/errors.ts
  └─ ConfigError (abstract)                src/bootstrap/errors.ts
```

## Reference

- Contract: `src/core/contracts/errors.ts`
- Spec: `docs/superpowers/specs/2026-03-18-error-handling-design.md`
