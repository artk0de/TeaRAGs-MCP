# Step 0: Check Progress

Run: `$SCRIPTS/progress.sh get`

- If progress file exists → find first step with `status != "completed"` →
  resume from there
- If no progress file → run `$SCRIPTS/progress.sh init` → start from Step 1
