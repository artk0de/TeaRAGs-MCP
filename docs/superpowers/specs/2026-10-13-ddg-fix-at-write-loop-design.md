# DDG fix-at-write loop — design

Bead: `tea-rags-mcp-89k7k.1.19` (Tier 3, first item). Follow-on: `r8hme.53`
(violation impact tiers) is blocked by this design.

## Goal

An agent that writes code through `tea-rags:data-driven-generation` (DDG) leaves
no architecture violation it introduced. Step 7 (VERIFY) asks `review_changes`
for architecture and cohesion as well as naming and incompleteChange, and the
agent repairs what it introduced before it commits. The same repair knowledge
serves `architecture-diagnostics` (recommendations) and `risk-assessment` (fix
cost), so it lives in one place.

A second, independent DDG defect is fixed alongside: the agent re-searches files
whose outline, symbol bodies or search hits are already in the conversation.

## Decisions (owner-approved 2026-10-13)

| #   | Question                                                            | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Scope of repair                                                     | Findings the diff INTRODUCED must be fixed. Pre-existing findings are fixed automatically only when the fix is cheap (D2); otherwise one report line plus a bead suggestion.                                                                                                                                                                                                                                                                                          |
| D2  | What "cheap" means (universal across languages)                     | ALL of: (a) edge edits only — retarget an existing import (internal file → the component facade; parent facade → the declaring file; declared type → an EXISTING contract); the symbol set is unchanged except at most one export line in one facade; no new files, interfaces or moves. (b) footprint ⊆ diff files + at most one facade. (c) a re-run of `review_changes` shows the finding gone and no new finding; tests green and untouched. No line-count limit. |
| D3  | Detector false positives                                            | Accepted without a fix ONLY with evidence: a detector flag (`compositionRoot`, `entryPoint`, `foundationTerminal`) or a cited project rule (file + quote). A bare "by design" is not evidence → fix or ask the user.                                                                                                                                                                                                                                                  |
| D4  | Loop bounds                                                         | At most 2 repair rounds. A round that adds a finding or breaks a test is reverted whole. Introduced findings left after 2 rounds → report the problem to the user (finding, what was tried, why it was reverted) and let them decide; never commit silently.                                                                                                                                                                                                          |
| D5  | Threshold flap (metric crosses the tolerance by ≤ 0.02)             | An ordinary introduced finding: fix by D2 if possible, otherwise report metric before/after, threshold and the diff edge that moved it, and let the user decide.                                                                                                                                                                                                                                                                                                      |
| D6  | Cohesion (`splitCandidates`)                                        | If the separate cluster consists ENTIRELY of symbols this diff added, move them to a neighbouring file with fitting vocabulary (or a new file per the folder's convention) — an exception to D2's "no new files", valid only for the agent's own new code. A cluster touching pre-existing symbols → one report line + bead suggestion, no split.                                                                                                                     |
| D7  | `silentCoupling` / `incompleteChange` (co-change partner untouched) | Inspect each partner (`find_symbol` / outline) and give a verdict with evidence: depends on the changed contract (test, doc, registry, mirror) → edit it in the same diff; does not → one line "not touched because …" citing the symbol. Never skip silently.                                                                                                                                                                                                        |
| D8  | Families invisible to diff review                                   | Add `layeringBackEdge` and `hubLike` to diff review. `hubLike` lands only after `g77p3` (edges into `contracts` no longer count toward a hub's Ce). `shotgunSurgery` stays out: it is a statistic over commit history, a single diff has no history to attribute, and its remedy (consolidation) is never cheap. At most an informational line, owned by `r8hme.53`.                                                                                                  |
| D9  | `preExisting` coverage                                              | Every diff family carries `preExisting`, computed against the `{base}` edges (today: cycles and leakingAbstraction only). D1 depends on it.                                                                                                                                                                                                                                                                                                                           |
| D10 | Who computes the cheap fix                                          | The server: an optional `remedy` field on the finding.                                                                                                                                                                                                                                                                                                                                                                                                                |
| D11 | Repair strategy storage                                             | One file per violation family, loaded ONLY when a finding of that family is present. Shared by DDG, architecture-diagnostics and risk-assessment.                                                                                                                                                                                                                                                                                                                     |
| D12 | Session-context reuse                                               | Outlines, symbol bodies and search hits already fetched in the conversation are the source of truth until the file is edited; re-fetch only files edited since.                                                                                                                                                                                                                                                                                                       |

## Server changes (`review_changes`, architecture section)

### Order

1. `g77p3` — hub Ce excludes edges into `contracts`.
2. `preExisting` for every family (D9).
3. `layeringBackEdge` family: a diff edge that runs against the layer order or
   closes a knot.
4. `hubLike` family: a diff edge that carries a component across the hub
   threshold, attributed to that edge (same shape as the mainSequence flap).
5. `DiffFindingRemedyResolver` with dry-run (below).

Each step is TDD: a red-first pin, then the change. `architecture-section.ts` is
a hotspot (bugFixRate 50, 20 commits, 593 LOC): new logic goes into its own
modules, the section only wires them.

### Remedy contract

Lives in `src/core/contracts/types/diff-detector-finding.ts`; optional on
`DiffDetectorFindingCommon`.

```ts
type DiffFindingRemedy =
  | {
      kind: "retargetImport";
      sourceRelPath: RelPath;
      fromRelPath: RelPath;
      toRelPath: RelPath;
      importedNames: string[];
      addExport?: { facadeRelPath: RelPath; names: string[] }; // ≤ 1 facade
    }
  | { kind: "restoreExport"; facadeRelPath: RelPath; names: string[] };
```

Names checked with `get_naming_lexicon`: `DiffFindingRemedy` CONFORMS,
`DiffFindingRemedyResolver` CONFORMS (project suffix Resolver — a search over
candidates that may decline, like `ConeDispatchResolver`), field `remedy`
matches the existing drift `remedy` usage.

### Candidate target per family

| Family                               | Candidate `to`                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| leakingAbstraction                   | `evidence.facadeRelPath` (already carried); `addExport` when the facade does not re-export the names                                                 |
| cycles                               | the file declaring the names, when it lies off the cycle path (the import went through a barrel on the cycle)                                        |
| stableDependencies, layeringBackEdge | the declaring file when the import goes through a re-export; or an existing contract of the same name in a more stable component / a permitted layer |
| hubLike                              | a target in a component the source already depends on, so Ce does not grow                                                                           |
| mainSequence                         | the stableDependencies rule applied to each edge of `evidence.edges`; a remedy only when fixing those edges brings D back under the threshold        |
| facadeContract                       | `restoreExport` for dropped names that still have consumers                                                                                          |
| silentCoupling, splitCandidates      | no remedy — the agent decides by the family's repair file                                                                                            |

### Dry-run invariant

A remedy is emitted only after the server re-ran the diff judgement on the
hypothetical edge set (the one edge replaced, the export added) and confirmed:
the finding is gone, and no built family gained a finding. The diff run already
works on edge lists, so the re-run is cheap. The remedy is therefore a verified
repair, not a hint; the agent's own re-run is confirmation.

The resolver declines (no `remedy`) when a name is declared in more than one
place, `to` does not export every imported name, the dry-run produces a new
finding, or the language has no export table.

## Repair strategy files

Location: `.claude-plugin/tea-rags/repair/<family>.md`, one per family:
`stableDependencies`, `leakingAbstraction`, `cycles`, `mainSequence`, `hubLike`,
`layeringBackEdge`, `facadeContract`, `silentCoupling` (also covers
`incompleteChange`), `splitCandidates`. DDG's existing
`skills/data-driven-generation/strategies/` holds generation modes and is not
reused for this.

Every file has the same five sections:

1. **What it means** — one sentence on what is broken.
2. **Apply remedy** — how to apply the server's `remedy`, when the family has
   one.
3. **No remedy** — the family's decision procedure (D6 for splitCandidates, D7
   for silentCoupling, edge-by-edge SDP for mainSequence, …).
4. **Known false positives** — which flags prove them, which project rules may
   be cited (D3).
5. **Escalate when** — the conditions that end in a user question.

A skill loads a file only for a family present in the findings it is acting on.

## DDG skill changes

### Step 7 (VERIFY) protocol

1. Call
   `review_changes(changes: {}, sections: ["naming", "incompleteChange", "cohesion", "architecture"])`.
2. Triage every finding:
   - **must-fix** — no `preExisting`;
   - **cheap-preExisting** — `preExisting` and a `remedy`;
   - **report-only** — `preExisting`, no `remedy`: one report line + bead
     suggestion.

   A family with `built: false`, or with `scopeSkippedFiles`, is stated as not
   judged / partial — never as a clean pass.

3. For each family with a must-fix or cheap finding, load exactly
   `repair/<family>.md`.
4. Repair round: apply `remedy`; else the family procedure; else accept by
   evidence (D3). Then re-run `review_changes` and the tests.
5. A new finding or a red test → revert the whole round (D4).
6. After 2 rounds with must-fix findings left → AskUserQuestion: the finding,
   what was tried, why it was reverted; options: fix this way / accept with a
   reason / bead. No commit without the answer.

The shared rules (D2 cheap, D3 evidence, D5 flap) are stated once in Step 7; the
repair files refer to them.

### Session-context reuse (D12)

Stated in Prerequisites and repeated at the two search-heavy steps (Step 2
context gathering, Step 5 naming): before a search, check the conversation for
an outline / symbol body / search hit of that file; reuse it unless the file was
edited after it was fetched.

## architecture-diagnostics changes

- `preExisting` is no longer cycles/leak-only: the anti-pattern bullet and every
  family phase read it.
- Read `remedy` when present: the recommendation for a violation quotes it.
- Diff-review families `layeringBackEdge` and `hubLike`; hub Ce after `g77p3`
  excludes contracts edges (update the hubLikeDependency phase reading).
- A violation's recommendation loads `repair/<family>.md` for that family only.
- D3 evidence discipline replaces "by design" wording.

## risk-assessment changes

- Phase 4 structural axis: a Critical/High candidate inside a component with an
  SDP, mainSequence or hubLike violation is escalated, by the same overlap rule
  already used for blast-radius hubs and cycles.
- The same flag discipline (D3): a `compositionRoot` / `entryPoint` /
  `foundationTerminal` component does not escalate.
- Fix cost for such a candidate reads the family's repair file (remedy present →
  cheap).

## Evals

`.claude-plugin/.benchmarks/data-driven-generation/evals.json` gains about 12
cases:

- session reuse: file known and unedited → no re-search; file edited since →
  re-fetch;
- must-fix with remedy applied;
- preExisting with remedy (auto-fix) and without (report-only + bead);
- round reverted on regression;
- escalation after 2 rounds, no commit;
- false positive with a flag (accepted) and without (fix or ask);
- flap handled as an introduced finding;
- cohesion: own cluster moved vs pre-existing cluster reported;
- co-change partner verdict with evidence;
- only the needed repair file loaded.

architecture-diagnostics and risk-assessment gain cases for `remedy` reading,
`preExisting` on SDP/mainSequence, and the structural escalation. Plugin version
bumped per `.claude/rules/plugin-versioning.md`.

## Testing

- Server: red-first unit pins per step; dry-run pins prove a remedy is emitted
  only when the re-judged edge set is clean, and declined otherwise.
- Live: `review_changes` on a crafted worktree diff that introduces one leak,
  one SDP edge through a barrel, and one back-edge — each finding carries a
  remedy, and applying it clears the finding on re-run.
- Skills: the eval cases above, run with the optimize-skill harness.

## Out of scope

- `shotgunSurgery` in the loop (D8) → `r8hme.53`.
- Impact tiers structural / active / critical → `r8hme.53`.
- Naming false negative on compound vendor terms → `tea-rags-mcp-z82cv`.
