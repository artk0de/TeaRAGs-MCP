---
paths:
  - "**/*"
---

# Epic Completion Gate (MANDATORY)

An epic that touched runtime code is NOT done when the suite is green. It is
done when the built worktree has been exercised against real data and the thing
the epic claims to have changed has been measured.

Green unit tests prove the code compiles and behaves against mocks. They do not
prove the pipeline still runs. This project has repeatedly shipped changes that
passed every spec and then failed on contact with reality: a worktree clone that
lost its embedding endpoints so the reindex died before enrichment ever started;
payload writes that unit tests could not see because the assertions ran against
an in-memory Qdrant; a schema-drift guard that only fires against a real index.
Every one of those was green when it landed.

## The gate — three steps, in order

### 1. Build the worktree

```bash
npm run build
```

A bare build is always allowed and collides with nothing — **the global
`npm link` pointer is the shared resource, not the build**. A fresh worktree has
no `build/`, and `chunker/infra/pool.ts` forks the COMPILED worker, so worker-
forking specs (and therefore pre-commit) fail until the worktree is built once.

Pair it with `npm link` ONLY when the MCP server has to load the change for
step 3. See `.claude/CLAUDE.md` → "MCP Integration Testing" for the link rules
and why relinking `main` by reflex breaks parallel sessions.

### 2. Run the real unit gate

```bash
npm run test:coverage
```

`npm test` is NOT the gate — pre-commit deliberately skips coverage for speed
and says so. An epic closed on `npm test` alone can still be below threshold.

### 3. Live validation — USER-GATED

Reindex and measure. **Never run this unasked**: it rewrites the shared Qdrant
index and depends on Ollama embeddings that can flap mid-run. Ask, state exactly
what you intend to run, and wait for explicit "reindex" / "замер".

Pick the validation that matches what the epic changed:

| Epic touched                                    | Live validation                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrichment, payload shape, signal descriptors   | `tea-rags index-codebase --project <alias> --wait-enrichments --force --json`, then confirm enrichment health has no `degraded` / `failed` and the unenriched count settles at 0 |
| Language resolver, walker, codegraph resolution | Re-measure `resolveSuccessRate` / `inProjectEdgeRecall` on the corpus the epic targets, against a baseline recorded BEFORE the first edit                                        |
| Query path, rerank presets, derived signals     | `npm run build && npm link`, ask for `/mcp reconnect`, then exercise the change through `mcp__tea-rags__*` — not through DuckDB-direct probes                                    |
| Migrations, schema versions                     | Run the migration against a real index and verify the drift guard reports clean                                                                                                  |

Always `DEBUG=1` on the index CLI, for per-phase timing.

## Closing rule

**A bead whose epic touched runtime code MUST NOT be closed on unit evidence
alone.** The `--reason` has to cite the live run: what was reindexed, what was
measured, and the number.

Implementation landing is not measurement passing. When the code is merged but
validation has not run, the bead is reset to `open` with what remains to measure
— not left `in_progress` as a bookmark, and not closed on intent. This is the
same failure `.claude/rules/worktree-beads-lifecycle.md` lists as an
anti-pattern; this rule is that anti-pattern stated as a positive obligation at
the epic level.

Validation cannot run yet (user unavailable, corpus busy, endpoint down) → close
the implementation for what landed and file the measurement as its own bead
linked to the epic. Never fold an unmeasured claim into a closing reason.

## Exceptions

The gate does not apply when the change provably cannot reach the pipeline:

- Docs, plans, specs, rule files — nothing to run.
- Type-only changes with no runtime emit.
- Test-only changes: the suite IS the validation.

"It is only a refactor" is NOT an exception. A behaviour-preserving change is a
claim, and the pipeline is what checks it — a decomposition that quietly drops a
write is exactly the defect mocks are worst at catching.

## Cross-reference

- `.claude/CLAUDE.md` → "Never auto-build / auto-reindex" — the authorization
  rules this gate obeys: bare build free, link scoped to MCP testing, reindex
  always user-gated.
- `.claude/rules/worktree-beads-lifecycle.md` — settling beads at teardown.
- `.claude/rules/session-completion.md` — the session-level checklist this sits
  inside.
