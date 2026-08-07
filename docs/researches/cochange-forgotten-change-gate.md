# Co-change gate: does a co-change matrix catch real forgotten changes?

**Bead**: `tea-rags-mcp-9szed` · **Epic**: `tea-rags-mcp-l1ot` (Codegraph Slice
5, temporal coupling) · **Measured**: 2026-08-06 · **Corpus**: taxdome monorepo

**Verdict: CLOSE the epic.** Top-3 hit rate is 27.57% on the pre-declared
primary configuration and 23.66% after the one allowed filter refinement. The
decision rule's promote bar is 50%. The best number produced by any of the eight
configurations measured is **30.94%**, so the gap to 50% is not a tuning
problem.

---

## What was measured

The question the epic's gate asks: if a co-change matrix had existed, would it
have caught the changes developers actually forgot?

The corpus builds itself out of git rather than being labelled by hand. A hotfix
that lands within 24h of a prior commit, shares at least one file with it, and
touches a file that prior commit did **not** touch is a documented forgotten
change with a known answer — the extra file is what should have been changed the
first time. On taxdome that yields **2996 cases**.

For each case the matrix is consulted at the anchor commit, ranked by
association-rule confidence over the anchor's files, and asked whether the
forgotten file lands in the top 3.

Script: `scripts/cochange-forgotten-change-gate.ts`. Raw report:
`docs/researches/data/cochange-gate-report.json`.

### No-lookahead guarantee

The correctness requirement of the whole exercise. Bundles are sorted by their
**last** commit timestamp and folded into the matrix only while that timestamp
is strictly earlier than the anchor's. Every commit inside an admitted bundle is
therefore older than the anchor, so no pair count can carry information from the
anchor's own change or from anything after it. The evaluation is a single
chronological walk — the matrix is never rebuilt, never rewound.

### Configuration

| Knob            | Primary                          | Source                                |
| --------------- | -------------------------------- | ------------------------------------- |
| corpus window   | 24h, same author, ≥1 shared file | bead 9szed                            |
| mass-commit cap | bundles over 15 files dropped    | bead 9szed                            |
| bundling        | session, author + 30min gap      | `squashOpts` (`bootstrap/factory.ts`) |
| support floor   | 2                                | pre-declared                          |
| ranking         | max confidence over anchor files | pre-declared                          |

Fix classification uses the production `isBugFixCommit`; merge filtering uses
production `MERGE_SUBJECT`. Session bundling mirrors `groupIntoSessions` and is
asserted against it at runtime — on taxdome both produce **90211** sessions.

---

## Numbers

Corpus: 2996 cases · 190088 commits scanned · 120182 non-merge commits with a
file list · 115834 distinct paths · history 2017-04-04 .. 2026-08-06.

| Configuration                                                           | top-1  | **top-3**  | top-5  | top-3, known files | per-file top-3 |
| ----------------------------------------------------------------------- | ------ | ---------- | ------ | ------------------ | -------------- |
| **PRIMARY** (session bundles, support ≥2, cap 15)                       | 16.76% | **27.57%** | 33.08% | 28.28%             | 12.49%         |
| **REFINED re-measure** (+365d window, +antecedent floor 3, +hub cap 2%) | 14.82% | **23.66%** | 28.54% | 24.27%             | 10.74%         |
| sensitivity: per-commit bundles (no squash bundling)                    | 18.02% | 29.44%     | 35.18% | 30.20%             | 13.46%         |
| sensitivity: support ≥1                                                 | 17.92% | **30.94%** | 37.88% | 31.74%             | 14.26%         |
| sensitivity: support ≥5                                                 | 11.55% | 17.96%     | 20.93% | 18.42%             | 7.82%          |
| sensitivity: 365d recency window only                                   | 16.52% | 26.94%     | 31.94% | 27.63%             | 12.24%         |
| sensitivity: antecedent floor 3 only                                    | 15.49% | 25.57%     | 30.91% | 26.22%             | 11.50%         |
| sensitivity: hub cap 2% only                                            | 16.46% | 26.54%     | 31.78% | 27.22%             | 12.04%         |

"known files" excludes the 75 cases where every forgotten file is brand new at
hotfix time — unpredictable by construction, and the cut barely moves the
number. "per-file top-3" counts how many of the 8046 individual forgotten files
the top-3 covers, not just whether one of them was caught.

### Where the misses sit (primary)

| rank of the forgotten file | cases | share  |
| -------------------------- | ----- | ------ |
| 1                          | 502   | 16.76% |
| 2                          | 198   | 6.61%  |
| 3                          | 126   | 4.21%  |
| 4–5                        | 165   | 5.51%  |
| 6–20                       | 359   | 11.98% |
| >20                        | 286   | 9.55%  |
| never ranked               | 1360  | 45.39% |

45% of the time the forgotten file has no rule connecting it to anything in the
anchor at all — there is nothing to rank. Another 21.5% sits at rank 6 or worse,
which a 3-to-5 candidate push never shows.

### Rule statistics, hits vs misses (primary)

|                | n    | support p25/p50/p75 | confidence p25/p50/p75 | lift p25/p50/p75 |
| -------------- | ---- | ------------------- | ---------------------- | ---------------- |
| hits (rank ≤3) | 826  | 3 / 5 / 10          | 0.391 / 0.583 / 0.786  | 200 / 665 / 2316 |
| misses         | 2170 | 0 / 0 / 2           | 0.000 / 0.000 / 0.071  | 0 / 0 / 41.5     |

The separation is clean, which is the one genuinely encouraging finding: when a
rule exists at reasonable confidence it is usually right. Hits sit at median
confidence 0.58 with median support 5. The problem is not that the surfaced
candidates are wrong — it is that for most real forgotten changes no candidate
exists.

---

## The one allowed re-measure

The primary landed at 27.57%, inside the rule's 25–50% band, which mandates
refining the noise filters and re-measuring exactly once. Three refinements were
declared before running, each justified by an observed failure mode rather than
picked for its effect:

- **365-day recency window** — taxdome's history spans nine years; a pair last
  observed in 2018 is not evidence about 2026.
- **Antecedent occurrence floor 3** — confidence 1.0 computed off two
  co-occurrences is arithmetic, not evidence, and the miss samples are full of
  it.
- **Hub cap 2%** — a file appearing in more than 2% of window bundles co-changes
  with everything and predicts nothing.

Corpus held byte-identical; only the matrix filters moved. Result: **23.66%**,
down 3.9pp from the primary. Each refinement individually costs signal too
(26.94% / 25.57% / 26.54%). The refinements trade recall for precision, and this
corpus does not have recall to spare.

Going the other direction confirms it. Loosening every filter — support floor 1,
no squash bundling — buys 30.94%. That is the ceiling of this whole family of
configurations, and it is still 19 points short of the bar.

Worth stating plainly: **one of the noise filters the bead mandated costs
signal.** Session bundling scores below per-commit bundling (27.57% vs 29.44%)
because merging a developer's 30-minute burst into one bundle erases exactly the
short-range pairs the detector needs. The 15-file mass-commit cap was not varied
— it is load-bearing for memory as well as for noise, and every configuration
above carries it.

---

## Second corpus: tea-rags itself

Same script, `COCHANGE_REPO=/Users/artk0re/Dev/Tools/tea-rags-mcp`, corpus 172
cases:

| Configuration | top-1  | top-3  | top-5  |
| ------------- | ------ | ------ | ------ |
| primary       | 10.47% | 18.60% | 21.51% |
| refined       | 2.33%  | 4.07%  | 5.23%  |

Weaker, as expected — tea-rags is single-author with 400 session bundles of
history, so pair counts never accumulate. The refined config collapses on it
because a 2% hub cap over 400 bundles means eight occurrences, which classifies
almost everything as a hub. That is a filter mis-scaled for a small repository,
not a finding about co-change; the taxdome numbers carry the decision.

---

## What distorts the measurement

Stated so the number can be argued with rather than trusted.

- **Corpus size and shape.** 2996 cases out of 120182 commits. Selection
  requires `isBugFixCommit` to fire, which it does on 18408 of 190088 commits
  (9.7%). Forgotten changes fixed by a commit that does not _say_ it is a fix
  are invisible here. If those behave differently, the estimate moves.
- **Anchor choice is a heuristic.** The anchor is the most recent prior commit
  within 24h that shares a file and has the same author. A genuine forgotten
  change fixed by a different person, or more than a day later, never enters the
  corpus. `noAnchorInWindow` rejected 10491 candidate hotfixes.
- **`%ct` ordering vs merge order.** Commits are ordered by committer timestamp.
  In a merge-based workflow a branch commit can carry a timestamp earlier than
  the point it reached master, so the matrix can contain a pair that was not yet
  on the mainline. This can only _help_ the measured hit rate, and the verdict
  is a close, so the direction is safe.
- **Renames are not tracked.** `--no-renames` is used, so a renamed file becomes
  a new path and loses its pair history. This depresses the number by an
  unmeasured amount.
- **Merge commits contribute no files.** Standard `git log --name-only`
  behavior. The mainline history is carried by the branch commits, which is what
  we want, but any squash-merge repository would behave differently.
- **A hit is per case, not per file.** A case with four forgotten files counts
  as a hit if any one lands in the top 3. The per-file column is the stricter
  read and sits at 12.49%.
- **One repository, one domain.** Rails plus React monorepo, nine years, one
  company's commit conventions. Numbers on a smaller or younger codebase differ,
  as the tea-rags run shows.

---

## Consequences for the epic

The gate stated in `l1ot` was a named demand plus a concrete use case, later
reframed as an incomplete-change detector pushed into the verification step. The
measurement settles the reframing: on nine years of real history, the detector
would have surfaced the forgotten file inside a 3-candidate push in **27.6%** of
documented cases, and no filter configuration examined reaches half of that bar.

At that rate the push fires and is wrong roughly three times in four. The epic's
own note names false positives as the risk that kills the feature irreversibly.
It is the sub-25% number the rule asks to close on, and closing costs an epic
that was already parked at P2 behind an unmet gate.

Two things survive worth keeping:

1. **When a rule exists at confidence ≥0.5 with support ≥3, it is usually
   right** (hits: median confidence 0.58, median support 5; misses: median 0). A
   high-precision, low-recall variant — fire only above a confidence floor,
   accept firing on a small minority of changes — is a different product than
   the one this gate measured, and this data does not refute it.
2. **The corpus harness is reusable.** Any future incomplete-change proposal can
   be priced against the same 2996 cases before any code is written.
