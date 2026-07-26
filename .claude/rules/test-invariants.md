---
paths:
  - "src/**"
  - "tests/**"
---

# Tests Assert Invariants, Not Implementation (MANDATORY)

Tests encode BUSINESS INVARIANTS. A test's job is to pin observable behavior,
not internal structure.

## Rules

1. **Tests change ONLY when a business invariant changes.** A
   behavior-preserving change (consolidation, decomposition, relocation,
   rename, delegation) MUST leave test expectations unchanged: suite green
   before and after, empty semantic diff under `tests/**`.

2. **A test that breaks under a behavior-preserving implementation change is a
   BAD TEST** — it asserts implementation, not invariant. Do NOT patch it to
   track the new implementation. Rewrite it as a good test: assert the
   observable behavior/invariant, decoupled from internal structure. Each such
   rewrite is justified explicitly in the commit message.

3. **Before landing a consolidation/refactor, verify specs are untouched.**
   `git diff --stat -- tests/` must be empty, or contain ONLY rule-2 rewrites
   (bad-test → invariant-test), each justified.

4. **Intentional invariant change goes through TDD.** New/changed invariant →
   failing test first (red), then implementation (green). Never edit the test
   and the code in one motion to "make it pass".

## Decision table

| Situation                                        | Action                                                      |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Refactor, suite green                            | Ship; tests untouched                                       |
| Refactor, test red, invariant unchanged          | Fix the CODE; if test asserts internals — rule-2 rewrite    |
| Business invariant changed intentionally         | Update test to the NEW invariant, red-first (TDD)           |
| New behavior                                     | New test (TDD), existing tests untouched                    |

## Relation to existing rules

Complements (does not supersede): business-logic tests immutable during
refactor (move OK, rewrite NO), never lower coverage thresholds,
relocation-migration order (relocate code → suite green → redistribute tests
LAST).
