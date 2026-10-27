# Step 7: VERIFY — data-driven-generation

Loaded by `SKILL.md` Step 7 and by wrappers that run its gate.

## Step 7 answer block

Lives in `skills/data-driven-generation/SKILL.md` Step 7
(`#### Step 7 answer block`) — the only definition of Step 7 output, printed
from there line by line. Checks 1–4 below say how to fill it.

## Checks

No per-identifier existence sweep — specs and the type-checker catch a
hallucinated name; the sweep only spends tokens. Verify what they miss:

1. **Symbol risks** — symbols the new code calls or changes, ≤ 5, most central
   first, in ONE
   `find_symbol(symbols: [<ids>], rerank: "criticalPath", metaOnly: true)`. Ids
   already labelled in context drop out of the list; the call still runs on the
   rest. Its chunk mask labels `codegraph.chunk.pageRank`,
   `codegraph.chunk.fanIn`, `codegraph.chunk.fanOut`, `bugFixRate`,
   `commitCount` — read `rankingOverlay.chunk.<field>.label`.
   - Callee `bugFixRate` critical → call it defensively (guard its inputs,
     handle its failure mode); confirm a test pins the scenario you rely on,
     else report it unpinned.
   - Changed symbol `pageRank` critical or `chunk.fanIn` central → Step 8
     `get_callers` (already mandatory for MODIFY).
   - Reviewer routing stays in Step 5 — not repeated here.
   - Codegraph off → `rerank: "dangerous"`: file-level labels only, react to
     `rankingOverlay.file.bugFixRate`. Never `dangerous` while codegraph is on —
     it leaves the chunk labels unread.
2. **N-th-way self-check:** `find_similar` with `positiveCode` = generated code;
   ignore hits on template + target file. Near-duplicate hit in another module =
   you wrote the N-th way → back to Step 4 gate (import instead) or surface to
   user.
3. **MODIFY** (signature change included): re-run the 6a baseline pins
   (`tests-at-risk` scenarios) + RED tests — all green, none edited except
   `PIN-UPDATED`. No 6a baseline recorded (edit made outside this flow) → run
   `/tests-as-context` `tests-at-risk` on the changed file now, then those
   scenarios. Baseline was "unpinned" → note behavior unpinned, proceed.
4. **GATE — `review_changes` before EVERY commit** (codegraph on): ONE
   `review_changes(changes: {}, sections: ["naming", "incompleteChange", "cohesion", "architecture", "norms"])`
   (`{}` = the uncommitted edit about to be committed; every commit passes the
   gate → branch covered by construction), then the fix-at-write loop below.
   Gate fails → no commit, no "done". Edits left uncommitted at hand-back → run
   it once more.
   - **naming** — GENERATE writes names Step 5 never judged (helpers, locals,
     constants, types); the section judges every name the added lines declare vs
     HEAD. Resolve each verdict in the answer now, concrete: `MISFIT` → name the
     rename to `suggestion` before commit (`cfg MISFIT → retryPolicy`);
     `COLLISION` → rename; `NEW_TERM` → soft: `alternatives` word only if same
     meaning (`LIMIT NEW_TERM → use BATCH_SIZE, both cap one batch`), else
     keep + one-line why (never default-rename); never "decide later" / "needs a
     decision"; `genericName` → rename; `novel` = no action. Skip naming when
     every added declaration was a Step 5 draft. Tests not judged (`notJudged`).
     Never hand-list written names into `names[]`.
   - **incompleteChange** = co-change partners the change ignores
     (`support`/`confidence` attached) — a forgotten sibling edit is caught
     here, not in review. Partner verdict rule below.
   - **cohesion** (`splitCandidates`) + **architecture** families → triage
     below.
   - **norms** = dependency-norm verdict per added file edge
     (`addedEdgeVerdicts`) → triage below.
   - **Pass** = ALL: (i) every architecture finding with `preExisting` not true
     and every `change.nonLocal` entry (= `change.introducedCount`) repaired per
     `repair/<family>.md`, or accepted false positive with QUOTED evidence
     (detector flag / cited rule) + filed detector bead; (ii) verdict not
     PARTIAL — any detector row `built: false`, `truncated` (envelope or
     detector row) or `scopeSkippedFiles` = PARTIAL ≠ pass, even at zero
     findings → re-run with `files: [...]` batches until every changed file is
     judged; (iii) triage table must-fix rows repaired.
   - `preExisting: true` = not yours: never blocks gate, never counted in
     `introduced`. With `remedy` → apply it (triage row cheap-preExisting);
     without → report-only line + bead.
   - Output: the answer block above. Count not supplied → run the review, never
     infer it; plan-only with unknown count → keep `<n>` as written.

### Fix-at-write loop

**Confirm first** — before a triage class, per finding. **Default presumption:
REAL.** Read its evidence fields (edge `source`/`target`, symbolId, metric +
tolerance, flags) and check:

1. The edge / symbol it names exists in the diff — or in the tree for a
   `nonLocal` entry (`find_symbol` / the diff hunk, reused if in context).
2. The metric is computed from that edge (the edge appears in the finding's
   evidence; removing it would move the metric).

Both hold → REAL → triage below. A finding that LOOKS wrong but passes 1–2 is
real: fix it, do not argue it away.

**False positive** only with COUNTER-evidence, quoted in its triage line:

- the edge / symbol does NOT exist (diff hunk or `find_symbol` shows its
  absence), or
- the detector misread a role / kind (quote the finding's role/kind vs the
  symbol's actual declaration read this session), or
- a known-noise class from the family's repair file (`## Known false positives`)
  whose CONDITION is shown to hold on THIS edge — cite the condition and the
  fact that meets it. Naming the class is not evidence.

Detector flags (`compositionRoot`, `compositionTable`, `parentSurface`,
`entryPoint`, `foundationTerminal`, `preExisting` without `remedy`) are
detector-sanctioned exemptions, not false positives: valid only QUOTED from the
finding's fields, never inferred from a file's path or role ("it's the bootstrap
folder" ≠ `compositionRoot: true`).

**Every accepted false positive files a detector issue** — the detector is
wrong, that is a defect, never a silent accept. Session has an issue tracker
(project beads, tickets) → file there; else `/report-issue`. Body: family,
finding fields verbatim, counter-evidence. Report line = the `FALSE-POSITIVE`
line of the answer block. No issue → not accepted → fix or ask.

**Triage** every architecture / cohesion / incompleteChange / norms finding
confirmed REAL:

| Finding                    | Class             | Action                                                                                  |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| no `preExisting`           | must-fix          | repair in this diff                                                                     |
| `preExisting` + `remedy`   | cheap-preExisting | apply `remedy` (cheap by construction)                                                  |
| `preExisting`, no `remedy` | report-only       | one line + bead suggestion; never refactor it in this diff; commit allowed              |
| cohesion `splitCandidates` | per owner         | `splitCandidates.md`: cluster all-own-new → move it; touches pre-existing → line + bead |
| `change.nonLocal` entry    | must-fix          | introduced away from diff — repair like no `preExisting`                                |
| `change.touchedActive`     | must-fix priority | edit hits live cascade (`tier` active/critical): repair or ask user                     |
| `change.persisting` entry  | report-only       | structural; one count line per family, no triage                                        |
| norms `MISFIT`             | must-fix          | route via `expectedPath`; skip only if `exclusionsUnchecked` condition shown to hold    |
| norms `NEW_PATTERN`        | report-only       | one-line why                                                                            |
| norms `UNJUDGED`           | report-only       | read `unjudgedReasonCounts` (pre-cap count per reason)                                  |

**Base** — `review_changes` base = `git merge-base HEAD main`, the branch's fork
point on main. Never an integration branch, never a sibling `worktree-agent-*`
branch: sibling code enters scope and its findings (naming, cycle edges) look
introduced. Stacked work → base STILL main's merge-base; findings from the stack
below belong to the stack owner — cite the owning commit, do not fix or triage.

`silentCoupling` = git history → always `change.persisting`. incompleteChange
and `splitCandidates` are history verdicts with no `preExisting` split — their
repair file's procedure decides. A family with `built: false` → report "not
judged", never a clean pass.

**Shared rules** (repair files refer here):

- **Cheap** = ALL of: edge edits only — retarget an existing import (internal
  file → component facade; parent facade → declaring file; declared type → an
  EXISTING contract); symbol set unchanged except ≤ 1 export line in one facade;
  no new files, interfaces or moves. Footprint ⊆ diff files + ≤ 1 facade. Re-run
  shows finding gone, no new finding, tests green and untouched. No line-count
  limit. A server `remedy` = cheap, already dry-run-verified.
- **Evidence** — a finding stays unfixed ONLY with: a detector flag QUOTED from
  the finding (`preExisting: true` with `remedy` absent, `compositionRoot`,
  `compositionTable`, `parentSurface`, `entryPoint`, `foundationTerminal`), a
  symbolId / file read THIS session, a cited project rule (file + quoted line),
  or a false positive per **Confirm first** (counter-evidence + filed issue).
  Each introduced / non-`preExisting` finding left unrepaired gets its OWN
  triage line citing one such token. Banned as reasons: "I believe", "by
  design", "budget", "out of scope", "fair nit", "not needed", group dismissal
  (one reason for N findings). Finding conceded valid → repaired, not dropped. A
  real incompleteChange gap (partner test with high `support` the diff should
  have touched) → fixed in the same round. No token → fix or ask.
- **Flap** — metric crosses the tolerance by ≤ 0.02 → ordinary introduced
  finding: fix if cheap, else report metric before/after, threshold and the diff
  edge that moved it; user decides. mainSequence detector drops |ΔD| ≤ 0.02
  itself (`excludedFlapCount`).

**Repair file:** per family with a must-fix or cheap finding, load exactly
`<plugin root>/repair/<family>.md` (plugin root = folder holding `skills/`).
Family = DETECTOR name on the finding, never the section name: files
`leakingAbstraction` `hubLike` `cycles` `stableDependencies` `layeringBackEdge`
`mainSequence` `facadeContract` `silentCoupling` `splitCandidates` (`.md`);
incompleteChange → `silentCoupling.md`, cohesion → `splitCandidates.md`;
`repair/architecture.md` / `repair/incompleteChange.md` do NOT exist; naming /
norms → no repair file. Finding given in task context = present → open its file
now. ONLY families that have a finding — never preload the directory.

**Round** (≤ 2):

1. Per finding: `remedy` present → apply it verbatim. `retargetImport`: in
   `sourceRelPath` point the import of `importedNames` from `fromRelPath` to
   `toRelPath`; `addExport` → add that one export line of `names` to
   `facadeRelPath`. `restoreExport`: re-export `names` from `facadeRelPath`.
   Else the repair file's `## No remedy` procedure. Else accept by evidence.
2. Re-run the same `review_changes` + targeted tests — MANDATORY after every
   repair, also a seeded / remedy one; report it: `target gone, no new finding`.
3. Re-run shows ANY new finding (even with the target finding gone) or a red
   test → the round regressed → revert the WHOLE round, then a different repair
   is the next round. Never keep the round and repair its new finding on top;
   never revert only part of it.
4. Must-fix left after round 2 → STOP, escalate: ask the user (subagent → hand
   back to orchestrator) with the `ESCALATE` line (metric before/after,
   threshold, diff edge that crossed it), what was tried, why reverted; options:
   fix this way / accept with a reason / bead. No commit without the answer —
   never commit around an introduced finding.

**Co-change partner verdict** (incompleteChange / `silentCoupling`): inspect
each untouched partner (`find_symbol` outline/body — reuse it if already in
context; several partners → ONE `find_symbol(symbols: [<partners>])`). Depends
on the changed contract (test, doc, registry, mirror) → edit it in this diff.
Else one line `not touched because <reason>` with a CHECKABLE reason citing the
symbol: a named test that already pins the seam, or why the file cannot change
with this edit. "Not needed" / "unrelated" without evidence = fail → edit it or
ask. Partner is a version manifest (`.claude-plugin/**/plugin.json`,
`package.json`, lockfile) → its manifest `PARTNER` line from the answer block,
verbatim.

**Report:** the answer block, then per class — fixed (remedy / procedure),
accepted (evidence), false positive (counter-evidence + issue), report-only
(bead suggestion), families not judged / partial.

Step 7 is the extension point for post-generation structural checks — add them
here, not as a second verification step.
