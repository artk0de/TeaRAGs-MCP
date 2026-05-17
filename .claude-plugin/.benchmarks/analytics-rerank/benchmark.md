# Analytics Rerank Benchmark

Last updated: 2026-05-16 (initial — skill created and optimized in single run)

## Summary

New agent-only skill (`user-invocable: false`) extracted from
`search-cascade.md`. Deep guidance on rerank-preset selection, custom weight
composition, and named analytics recipes (ownership, tech-debt, hotspots,
code-review, security-audit, Fragile Silo, impact analysis, active-driver
concentration).

Trigger-coverage probe: prompts name an analytics intent ("bug-prone areas",
"tech debt", "stable but breaks a lot", "blast radius") but never say "rerank"
or name a preset. Tests whether the agent self-triggers the skill, picks the
right preset, and routes correctly between sibling skills (`risk-assessment` for
multi-dim cross-preset scans, `bug-hunt` for debug, `filter-building` for filter
shape).

## Results

| Coverage           | With-rule    | Without-rule | Delta |
| ------------------ | ------------ | ------------ | ----- |
| Trigger            | 12/12 (100%) | 6/12 (50%)   | +50pp |
| Phase 8 (live MCP) | 5/5 (100%)   | n/a          | n/a   |

**Phase 8 — Full Integration Eval (2026-05-17)** — real tea-rags MCP calls on
the `tea-rags` project (collection `code_8b243ffe`). Cases A8-1 through A8-5
verify preset acceptance, custom-recipe shapes, rankingOverlay structure, and
the schema's behavior on wrong weight keys. Full results: `phase8-evals.json`.
Key finding: **A8-3 shows that the wrong weight key `bugFixRate` is SILENTLY
DROPPED — not rejected.** The call succeeds, the ranking does NOT reflect the
intended `bugFix` weighting, no warning. Baseline subagents using `bugFixRate`
(5/12 Phase 2 cases) would get ranked results that look fine but ignore the key
entirely. The skill's pointer to `tea-rags://schema/signals` as the canonical
catalog is the only defence against this silent degradation. A8-5 also verified
the single-call diagnostic claim (`find_symbol + rerank` attaches full
`rankingOverlay` to symbol-mode results).

## Where the skill matters most (per-eval delta)

The baseline (no skill) handles **well-known preset names** (hotspots, techDebt,
ownership, codeReview, securityAudit) — these come through training data. The
skill adds value in **three failure modes**:

| Failure mode (without skill)                     | Cases affected                                       | Skill correction                                                                          |
| ------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Wrong weight key `bugFixRate` (actual: `bugFix`) | T6, T8, T10, T11, T12                                | Skill names exact keys; pointer to `tea-rags://schema/signals` for canonical list         |
| Reinventing curated preset as custom weights     | T8 (proven), T10 (refactoring), T12 (securityAudit)  | Cheat-sheet table maps intent → preset name; the preset already curates the right signals |
| Missing specialty signals                        | T6 (knowledgeSilo), T9 (recentActivityConcentration) | Named Fragile-Silo and Active-Driver recipes in body                                      |
| Wrong skill for multi-dim cross-preset scan      | T11 (full health scan)                               | Description explicitly routes to `tea-rags:risk-assessment`                               |

## Per-eval result

| ID  | Prompt                                       | Expected                                       | With | Baseline | Baseline failure                                              |
| --- | -------------------------------------------- | ---------------------------------------------- | ---- | -------- | ------------------------------------------------------------- |
| T1  | "bug-prone areas in payments"                | hotspots                                       | PASS | PASS     | —                                                             |
| T2  | "tech debt in ingest"                        | techDebt                                       | PASS | PASS     | —                                                             |
| T3  | "single-author silos in auth"                | ownership                                      | PASS | PASS     | —                                                             |
| T4  | "review payments last week"                  | codeReview + maxAgeDays                        | PASS | PASS     | (functional, raw filter)                                      |
| T5  | "security audit auth/crypto"                 | securityAudit                                  | PASS | PASS     | —                                                             |
| T6  | "stable but breaks a lot in payments"        | Fragile Silo custom                            | PASS | FAIL     | Wrong key 'bugFixRate', missing knowledgeSilo                 |
| T7  | "high blast radius imports"                  | impact custom                                  | PASS | PASS     | (close-enough weights)                                        |
| T8  | "stable pagination low-bug"                  | proven preset                                  | PASS | FAIL     | Wrong key 'bugFixRate', reinvented preset                     |
| T9  | "active drivers in auth"                     | active-driver custom                           | PASS | FAIL     | Used ownership (blame) instead of recentActivityConcentration |
| T10 | "refactor candidates payments"               | refactoring preset                             | PASS | FAIL     | Wrong key, reinvented preset                                  |
| T11 | "full code health scan whole project"        | DELEGATE to risk-assessment (4-preset overlap) | PASS | FAIL     | Single search w/ custom weights, no overlap mechanic          |
| T12 | "[subagent] legacy auth >1yr w/ bug history" | securityAudit + filter                         | PASS | FAIL     | Wrong key, missed preset                                      |

## Iterations

| Iteration | Skill version | Pass rate    | Key change                                |
| --------- | ------------- | ------------ | ----------------------------------------- |
| 1         | initial draft | 12/12 (100%) | First-pass design                         |
| 1         | baseline      | 6/12 (50%)   | wrong key, reinvention, multi-dim routing |

100% with-rule pass without iteration — design held up on first probe.

## Key design decisions

1. **Preset cheat sheet as a routing table.** Body opens with a question→preset
   table (11 rows) before any deep prose. The agent triggers the skill via
   description, scans the table to find the matching question shape, picks the
   preset. Saves the agent from reading the whole body.

2. **Custom recipes are named.** Fragile Silo, Impact analysis, Active driver
   concentration, Security-sensitive legacy are full code-block recipes in the
   body. The skill body is the only place where "Active driver" is distinguished
   from "Ownership" — without it, the baseline collapsed them (T9 failure).

3. **Catalog pointers are canonical, not memorized.** Body explicitly tells the
   agent: "memorized lists from training data WILL drift. Read
   `tea-rags://schema/signals` for the live weight-key catalog." This is the
   primary mitigation against the `bugFixRate` vs `bugFix` baseline failure
   pattern (5/12 cases).

4. **NOT-for routing is concrete.** Description names the three siblings
   (risk-assessment / bug-hunt / filter-building) by intent. T11 (multi-dim)
   tests the boundary; both versions caught the intent name, but only with-rule
   actually delegated.

## Metrics

- Skill body: 184 lines + frontmatter

## Persistence

- `evals.json` — 12 trigger cases with results + failure taxonomy
- `workspace/skill-snapshot/after.md` — final SKILL.md
- This benchmark.md

## Limitations

- **Baseline already strong on well-known presets** — T1-T5 PASS without skill
  because preset names come through training. Delta is concentrated in the 5
  hard cases (Fragile Silo, proven, active-driver, refactoring, securityAudit in
  subagent context). Real value is "skill prevents training-data drift".
- **Wrong weight key name (`bugFixRate`) is the biggest failure mode** (5/12).
  Skill mitigates by pointing at `tea-rags://schema/signals` resource; live
  integration test (Phase 8) would confirm the resource actually contains the
  correct names. Not run in this iteration.
- **No multi-turn simulation** — single-prompt eval; conversational drift not
  measured.
