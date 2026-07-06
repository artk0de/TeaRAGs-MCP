# Step 7: Analyze Project (git recommendations)

The analyze-project.sh was already run in Step 4b for LOC. Use its full output
for git recommendations now.

If `isGitRepo` is true → AskUserQuestion:

```
question: "Enable git analytics? Provides authorship, churn, and bug-fix rate signals for code search."
options: [
  { label: "Yes", description: "Recommended — git repository detected" },
  { label: "No", description: "Skip git enrichment" }
]
```

If git enabled → AskUserQuestion (git history engine). Compute the
recommendation from the `analyze-project.sh` output first:

- `fileCount > 10000` OR `loc > 1000000` OR `commitCount > 20000` →
  **es-git** is Recommended (large project / monorepo)
- otherwise → **git** is Recommended (small project, short history)
- a metric missing from the analyze output → treat its clause as false

```
question: "Git history engine? es-git reads history in-process (no per-operation git process spawn); git uses the system git binary."
options: [
  { label: "git",    description: "System git CLI. Small projects, short history." },
  { label: "es-git", description: "In-process library (napi-rs/libgit2). Large projects, monorepos, EDR-throttled machines." }
]
```

Append " (Recommended)" to the label selected by the rule above.

If `es-git` chosen → install and verify the binding immediately:

```bash
npm install -g es-git
node -e "require('es-git')" && echo "es-git OK"
```

On install/verify failure: show the error, AskUserQuestion whether to retry
after fixing the toolchain or to fall back to `git`. Never continue with a
broken `es-git` selection — at runtime tea-rags fail-louds on any git
operation when the selected binding cannot load (escape hatch:
`GIT_ADAPTER=git`).

Save the choice to progress as `gitAdapter` (`"git"` or `"es-git"`) — write it
explicitly for BOTH choices; the value is pinned per-project in the MCP env
block (step 8) and captured into the project registry at first indexing.

If git enabled AND `hasFrequentCommits` is true → AskUserQuestion:

```
question: "Enable squash-aware sessions? Detected frequent commits from {topAuthor} (median {avgGapMinutes}min gap). Groups rapid commits into logical sessions for cleaner analytics."
options: [
  { label: "Yes", description: "Recommended for this commit pattern" },
  { label: "No", description: "Keep individual commit granularity" }
]
```

Save choices to progress.
