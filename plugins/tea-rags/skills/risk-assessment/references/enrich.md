# Phase 4: ENRICH — risk-assessment

Loaded by `SKILL.md` Phase 4. Critical + High + Medium candidates (cap 10, tier
order); Low rows get no enrichment.

For **Critical, High and Medium** candidates (cap 10 chunks; runs when
Critical/High are empty):

**1. Code review** — Phase 1/1b scans contain metadata and signals only
(`metaOnly: true`). Every Critical/High/Medium row needs its body: the card's
`What's wrong:` line describes the code, not the signals. Reuse bodies already
in context (including EXPAND results). Collect the remaining
Critical/High/Medium symbolIds into ONE
`find_symbol(symbols: [<ids>], metaOnly: false)` batch; no body fetch for
discarded candidates. Surrounding context → `find_symbol` (Rule 5), not Read.
Never re-fetch an unedited body already held.

**2. Test coverage check — stratified, NEVER one batched call.**

Candidates come from different domains. Joining every symbol name into one
`hybrid_search` makes BM25 score them as a single bag of terms, so the domain
owning the largest test files takes every slot and every other candidate returns
empty. Empty then reads as "untested" — a fabricated finding, and the most
damaging output this skill can produce, because it looks like a real result.

Procedure — one call per domain cluster, reusing the Phase 1 stratification:

```text
1. Group Critical/High/Medium candidates by relativePath directory prefix
   (same grouping as the Phase 1 dominant-domain count).
2. Per cluster: hybrid_search
     query      = that cluster's symbol names only
     testFile   = "only"
     metaOnly   = true
     limit      = 15
3. Verdict per candidate comes ONLY from its own cluster's call.
```

Typically 2-3 calls, not 1. That is the correct cost — a wrong "untested"
verdict costs the operator far more than two extra scroll queries.

- Symbol present → note test path (do NOT read test content)
- Symbol absent **from its own cluster's call** → "untested risk zone"
- Symbol absent from a call another domain dominated → **no verdict**, re-query

**Exact alternative (preferred when the test path convention is known).**
`find_symbol({relativePath: "<mirrored test path>", metaOnly: true})` is an
exact lookup — no BM25, no crowding, no stratification needed. Mirror the source
path into the test root (`src/core/foo/bar.ts` → `tests/core/foo/bar.test.ts`).
Miss = genuinely absent. Use this when the layout mirrors predictably; fall back
to stratified `hybrid_search` when it does not.

**3. Structural amplifier + cycles (codegraph axis).** ONLY when graph tools
registered (`## Codegraph resolve` above). Tools absent — skip, note structural
risk not assessed (never claim "no cycles" / "no hubs"). See
`tea-rags://guide/navigation` "Graph navigation" for off-routing.

- **Blast-radius amplifier (`architecturalHub`).** Run `rank_chunks`
  `rerank="architecturalHub"` scoped to same `pathPattern`, same
  `testFile`/`documentation` exclusions as Phase 1, `metaOnly: true`.
  Cross-reference resulting `isHub=true` / high-`fanIn` files with Critical/High
  candidates by `relativePath`. Risk candidate ALSO a hub = **blast-radius hub**
  — escalate (tag Risk Type, sort to top of its tier): change there ripples
  across many dependents. Amplifier on already-identified risk, NOT a 5th MERGE
  preset — clean high-fanIn hub with healthy git signals is backbone, not risk.
- **Structural-violation amplifier (`get_architecture_report`).** Only when the
  task explicitly requests architecture diagnostics or structural refactoring; a
  risk/health scan alone does not authorize it. Reuse an existing report where
  available. Otherwise skip this amplifier; do not load the diagnostics skill or
  report merely to gather context. Eligible task: run once:
  `get_architecture_report(path: "<your working directory>", pathPattern: "<same scope>", detectors: ["stableDependencies", "mainSequence", "hubLikeDependency"])`
  — only the three groups it reads. Candidate inside a component with an SDP,
  mainSequence or hubLike violation (match on the component's files, same
  overlap rule as blast-radius hubs) = **structural-violation** — escalate (tag
  Risk Type, sort to top of its tier). Component flagged `compositionRoot`,
  `entryPoint` or `foundationTerminal` does NOT escalate: the position is its
  job (triage data). Violation `tier` orders escalation: critical (change
  cascades into wide reach) > active (edge co-changes beyond chance) >
  structural-only; untiered (mainSequence, hubLike) ranks as structural. A
  violation alone, without an identified risk candidate, is
  `architecture-diagnostics` territory — not a risk row. Zero judged = "not
  judged", never "clean".
- **Cycles (`find_cycles`).** Run `find_cycles scope=file pathPattern=<scope>`.
  Circular dependencies = structural risk churn presets cannot see. Noise guard:
  > 20 cycles unscoped → narrow by subdomain. Empty result with codegraph ON =
  > valid "no cycles (DAG)". Surface findings in OUTPUT Structural risks
  > section.

**4. Fix-cost classifier** — every Critical/High/Medium risk candidate AND every
Phase 1b structural candidate. Scored from overlay signals already fetched —
zero extra calls.

| Input                   | 0                | 1         | 2        |
| ----------------------- | ---------------- | --------- | -------- |
| `chunk.fanIn`           | unused / typical | frequent  | central  |
| `file.transitiveImpact` | local            | regional  | systemic |
| `chunk.pageRank`        | peripheral       | important | critical |
| tests (step 2 result)   | present          | absent    | —        |

Sum → 0-2 `cheap`, 3-4 `moderate`, 5+ `expensive`.

Structural violation present → read `../../../repair/<family>.md`
(`stableDependencies`, `mainSequence`, `hubLike`; only families found, never the
directory). A violation whose repair file has a `remedy`-style cheap path (edge
edits only: retarget an import or restore one facade export) → `cheap`
regardless of the sum; no cheap path (`## No remedy` ends in split / move) → at
least `moderate`. Tests and the overlay inputs still decide the rest.

Missing tests feeds BOTH risk (defect likelihood) AND cost (refactor safety).
Intentional: one input, two different quantities.

Codegraph off → those rows score 0; mark the estimate partial, never claim
`cheap` from missing signals.

**5. God-class attribution** — for `godModule` hits.

1. File mass from `godModule` overlay: `rankingOverlay.file.moduleLines` +
   `rankingOverlay.file.moduleMethodCount`, value + label. Overlay has NO
   per-class numbers — file-level result, no chunk bucket.
2. Per hit, cap 5: `find_symbol({relativePath})` → outline. Per-class member
   count = distinct member symbolIds under class, `#partN` folded. Spans from
   `startLine` / `endLine`.
3. Verdict:
   - One class holds most of file's callables → **god class**. Report class
     symbol + its outline member count.
   - Callables spread top-level, no dominant class → **god module**. Report
     file + `moduleMethodCount` + `moduleLines`.

Member counts ALWAYS from outline (exact), file mass ALWAYS from overlay.

**6. Risk classification** — from overlay labels + tier + test coverage.

**BEFORE picking a class, consult pair diagnostics.** Single overlay signals
ambiguous. `../../../rules/references/signal-interpretation.md` gives
pair/triple rules that disambiguate patterns (god module vs bug attractor,
healthy owner vs toxic silo, active development vs coupling, legacy minefield vs
proven stable). Read whenever overlay shows more than one strong signal.

**Key disambiguators** (always check before classifying):

- `imports` (fan-in, file-level) separates coupling (high) from bug attractor
  (low). **Codegraph on → prefer real `fanIn` / `isHub` / `transitiveImpact`
  signals over `imports` proxy** — they measure call/import edges, not raw
  import-line count. See signal-interpretation "Structural signals" +
  blast-radius-hub / cyclic-coupling patterns.
- `bugFixRate` separates healthy (stable) from fragile (unstable)
- `ageDays` inverts churn meaning (old+churn = minefield, young+churn = feature)
- `blameDominantAuthorPct` alone does NOT mean silo; pair with bugFixRate or age
- `recentDominantAuthorPct` = activity concentration (who's committing lately),
  NOT who owns live code — only `blame*` speaks to ownership
- path heuristic (`dto/`, `schema/`, `generated/`) flags boilerplate churn

**File × chunk refinement.** File-level signals point to which file. Chunk-level
signals (`chunk.bugFixRate`, `chunk.ageDays`, `chunk.relativeChurn`,
`chunk.blameContributorCount`, `chunk.recentContributorCount`) point to which
method inside. Overlay shows both → chunk-level locates exact problem:

- Coupling point → find chunk with highest `chunk.recentContributorCount`
  (recently-touched-by-many — overloaded API)
- Knowledge silo zoom-in → find chunk with `chunk.blameContributorCount = 1`
  (single live-line owner of a method inside a shared file)
- Legacy minefield → find chunk with highest
  `chunk.bugFixRate + chunk.relativeChurn`
- Bug attractor → find chunk with highest `chunk.bugFixRate`
- Fossil vs active legacy → `chunk.ageDays` inside old file

See `../../../rules/references/signal-interpretation.md` § "Method-level (chunk)
pair diagnostics" for the full table.

See [references/classification-tiers.md](./classification-tiers.md) for the full
13-tier table.

**7. Commit evidence** — Critical/High/Medium rows (+ Structural debt rows with
`Also risk?` set). Index stores `taskIds` only, no commit list → git is the
source; the ONLY git read in this skill. ONE Bash call, commands joined by `;`
(runs in sh, zsh, fish), one `echo "== <#>"` marker per row:

```text
git remote get-url origin; git status --porcelain -- <file1> <file2> …; echo "== 1"; git log -L<startLine>,<endLine>:<file1> -s --no-merges -n 20 --format='%H %as %s'; echo "== 2"; git log --follow --no-merges -n 20 --format='%H %as %s' -- <file2>
```

- Method / chunk row (has `startLine`–`endLine`) → `-L<start>,<end>:<file>` —
  history of those lines, not the whole file.
- File row (`godModule` god-class / god-module) → `--follow -- <file>`.
- File listed by `git status --porcelain` → keep the `-L` result, card adds
  `(uncommitted edits — ranges may be shifted)`.
- Never a repo-wide `git log`, never `git blame`, never one call per row.

Three commit classes per row:

- **bug-fix** — subject matches `fix:` / `fix(<scope>):` / `hotfix:`, `[Fix]`
  `[Bug]` `[Hotfix]` `[Bugfix]`, `<TICKET-123> fix…`, or
  `fixes|resolves|closes #<n>`.
- **cosmetic** — fixes typo, lint, format, style, whitespace, imports, tests,
  specs, flaky, ci, conflicts, or review. Never picked, never tagged; still
  counted in `<total>`.
- **other** — everything else.

Pick ≤3 per row: bug-fix (newest first), then other (newest first). Subject cut
at 72 chars.

Link — normalize remote to `https://<host>/<owner>/<repo>` (strip `git@`,
`ssh://`, `:port`, `.git`; `host:path` → `host/path`):

| Host                                 | Commit URL              |
| ------------------------------------ | ----------------------- |
| `github.com`, `codeberg.org`, gitea  | `<base>/commit/<sha>`   |
| `gitlab.com`, host containing gitlab | `<base>/-/commit/<sha>` |
| `bitbucket.org`                      | `<base>/commits/<sha>`  |
| other host / no remote               | bare `<sha7>`, no link  |

Print `commits: <rows> rows, remote <host|none>`. Rows with no commit in range →
`Commits: none in history window`.
