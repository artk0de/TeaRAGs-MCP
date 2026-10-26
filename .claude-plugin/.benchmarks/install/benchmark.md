# Install Skill Optimization — 2026-04-12

## Summary

The install wizard skill had 4 bugs that caused it to **actively harm** agent
behavior (0% with-rule vs 100% baseline). All 4 were confirmed by eval and
fixed.

## Changes

| #   | Finding                                                    | File                | Fix                                                |
| --- | ---------------------------------------------------------- | ------------------- | -------------------------------------------------- |
| 1   | MCP command `npx tea-rags server` instead of global binary | step-8-configure.md | Changed to `tea-rags server`                       |
| 2   | Node version "22+" in text but script requires 24+         | step-2-node.md      | Changed all "22+" to "24+" (3 occurrences)         |
| 3   | `npx tea-rags --version` in embedded qdrant setup          | setup-qdrant.sh     | Changed to `tea-rags --version`, updated error msg |
| 4   | No guard against old Node staying in PATH after install    | step-2-node.md      | Added CRITICAL block rule + re-detect instruction  |

## Key Design Decisions

- **Global binary over npx**: Step 3 installs tea-rags globally via
  `npm install -g`. All subsequent usage should reference the global binary
  directly (`tea-rags`), not `npx tea-rags`. npx adds latency, may use cached
  old versions, and may not trigger postinstall hooks.
- **Explicit version guard**: Added CRITICAL instruction to block progression
  until `install-node.sh` confirms >= 24. Prevents agents from using stale PATH
  entries.

## Metrics

- **Lines**: step-2-node.md 51 -> 56 (+5), step-8-configure.md unchanged,
  setup-qdrant.sh unchanged
- **Eval cases**: 10
- **Iterations**: 1 (all passed on first fix attempt)

## Results

```
Before fix:   0/10 PASS (0%)
After fix:    10/10 PASS (100%)
Baseline:     10/10 PASS (100%)
Delta:        0pp (skill no longer harms — matches baseline)
```

## Per-Eval Detail

| Eval | Prompt                           | Before                  | After |
| ---- | -------------------------------- | ----------------------- | ----- |
| 1    | Node v20, fnm available          | FAIL (22+, npx)         | PASS  |
| 2    | Fresh machine, embedded qdrant   | FAIL (22+, npx x2)      | PASS  |
| 3    | Node v18, volta                  | FAIL (22+, npx)         | PASS  |
| 4    | Embedded qdrant                  | FAIL (npx x2)           | PASS  |
| 5    | Resume, Node v22                 | FAIL (22+ UX confusion) | PASS  |
| 6    | macOS Apple Silicon, Ollama      | FAIL (npx)              | PASS  |
| 7    | Docker qdrant                    | FAIL (npx)              | PASS  |
| 8    | [subagent] task-agent, Node v20  | FAIL (22+)              | PASS  |
| 9    | [subagent] explore, ONNX Windows | FAIL (npx)              | PASS  |
| 10   | Node 24 + tea-rags already done  | FAIL (npx)              | PASS  |

## 2026-10-23 — harness-context-economy re-run (Task 12)

- Subject model: sonnet (plan-only simulation, blind; graded by sonnet grader)
- Result: 2/10 PASS (20%)
- Last recorded with-skill rate: 100%
- Delta: -80pp
- FAIL:
  - `1` — plan never states the MCP command is 'tea-rags server' (not npx) |
    REAL
  - `2` — no MCP command 'tea-rags server'; embedded postinstall 'tea-rags
    --version' not mentioned | REAL
  - `3` — no MCP command 'tea-rags server' (24+ and re-detect are met) | REAL
  - `4` — no postinstall 'tea-rags --version', no 'npm install -g tea-rags'
    error message, no MCP command | REAL
  - `6` — no MCP command 'tea-rags server' (step sequence is covered only via
    "tail as usual") | REAL
  - `7` — MCP command 'tea-rags server' not stated (only QDRANT_URL in step 8) |
    REAL
  - `9` — no MCP command 'tea-rags server'; it declines to run the wizard (ONNX
    recommendation itself is correct) | REAL
  - `10` — no MCP command 'tea-rags server' (skip to step 4 is met) | REAL
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex run (Task 14)

- Subject: Codex CLI 0.162.1, default model, plugins via repo-root marketplace,
  real hooks (plan-only)
- Result: not graded - 10/10 N/A (tea-rags-setup:install is not shipped to
  Codex)
- Claude T12 rate for comparison: 2/10 (20%)
- CODEX-ONLY: none
- Both-fail count: 0

## 2026-10-23 — evals-to-100 re-run (Task 22)

- Subject model: sonnet (plan-only simulation; graded strictly, borderline =
  FAIL)
- Result: 10/10 PASS (100%) over scored cases. 0 superseded. Subject found the
  skill at .claude-plugin/tea-rags-setup/skills/install (not tea-rags/).
- Task 12 rate: 20% (2/10)
- Delta: +80pp
- FAIL list: none
- Context: new SessionStart core+digest / SubagentStart block; old plugin hook
  text present in subject context but declared void (limitation).

## 2026-10-23 — Codex re-run (Task 22)

- Subject: Codex CLI 0.162.1, default model, plugins (tea-rags 0.46.10 +
  dinopowers 0.24.3 + superpowers 7.0.1) via repo-root marketplace, real hooks
  (plan-only)
- Result: not graded — 10/10 N/A (tea-rags-setup:install not shipped to Codex)
- Codex T14 rate: N/A (10/10)
- Claude T22 rate: 100% (10/10)
- FAIL list: none
