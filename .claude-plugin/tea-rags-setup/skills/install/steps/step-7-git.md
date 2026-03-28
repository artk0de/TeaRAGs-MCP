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

If git enabled AND `hasFrequentCommits` is true → AskUserQuestion:

```
question: "Enable squash-aware sessions? Detected frequent commits from {topAuthor} (median {avgGapMinutes}min gap). Groups rapid commits into logical sessions for cleaner analytics."
options: [
  { label: "Yes", description: "Recommended for this commit pattern" },
  { label: "No", description: "Keep individual commit granularity" }
]
```

Save choices to progress.
