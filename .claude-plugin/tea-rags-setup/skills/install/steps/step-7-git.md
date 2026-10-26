# Step 7: Analyze Project (git recommendations)

analyze-project.sh already ran in Step 4b — use its full output here.

`isGitRepo` true → AskUserQuestion:

```
question: "Enable git analytics? Provides authorship, churn, and bug-fix rate signals for code search."
options: [
  { label: "Yes", description: "Recommended — git repository detected" },
  { label: "No", description: "Skip git enrichment" }
]
```

Git enabled → AskUserQuestion (history engine). Recommendation from
`analyze-project.sh` output:

- `fileCount > 10000` OR `loc > 1000000` OR `commitCount > 20000` → **es-git**
  Recommended (large project / monorepo)
- else → **git** Recommended (small project, short history)
- metric missing → its clause false

```
question: "Git history engine? es-git reads history in-process (no per-operation git process spawn); git uses the system git binary."
options: [
  { label: "git",    description: "System git CLI. Small projects, short history." },
  { label: "es-git", description: "In-process library (napi-rs/libgit2). Large projects, monorepos, EDR-throttled machines." }
]
```

Append " (Recommended)" to label picked by rule.

`es-git` chosen → install + verify binding immediately:

```bash
npm install -g es-git
node -e "require('es-git')" && echo "es-git OK"
```

Install/verify fails → show error, AskUserQuestion: retry after fixing
toolchain, or fall back to `git`. Never continue w/ broken `es-git` — runtime
fails loud on any git op when binding can't load (escape hatch:
`GIT_ADAPTER=git`).

Save progress `gitAdapter` (`"git"` / `"es-git"`) — explicitly for BOTH; pinned
per-project in MCP env (step 8), captured into registry at first indexing.

Git enabled AND `hasFrequentCommits` true → AskUserQuestion:

```
question: "Enable squash-aware sessions? Detected frequent commits from {topAuthor} (median {avgGapMinutes}min gap). Groups rapid commits into logical sessions for cleaner analytics."
options: [
  { label: "Yes", description: "Recommended for this commit pattern" },
  { label: "No", description: "Keep individual commit granularity" }
]
```

Save choices to progress.
