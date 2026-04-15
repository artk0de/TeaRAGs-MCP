# Step 2: Install Node.js

Run: `$SCRIPTS/install-node.sh <versionManager>`

**Interpret result:**

- `already_done` → update progress, move to Step 3
- `installed` → update nodePath in progress, move to Step 3
- `manual_required` (exit code 2) → check `currentVersion` in result. If not
  null, include in the message (e.g. "Node.js 24+ required, found v18.19.0").
  Use AskUserQuestion:
  ```
  question: "Node.js 24+ is required{. Found vX.Y.Z — upgrade needed | but not installed}. How would you like to install it?"
  options: [
    { label: "Version manager", description: "Install fnm/volta/nvm first, then Node.js through it (recommended for developers)" },
    { label: "Direct install", description: "Install Node.js directly from nodejs.org or via system package manager" },
    { label: "Already installed", description: "I've already installed Node.js 24+ — just re-detect" }
  ]
  ```

**If "Version manager"** → filter by platform using tables in `reference.md`,
then AskUserQuestion with platform-specific options.

Note: if `hasWinget` is false on Windows, show manual download URLs instead of
winget commands.

After user picks a manager, suggest running via `!` prefix so it executes
in-session. Example:

"To install, type in the prompt: `! winget install CoreyButler.NVMforWindows`"

Then AskUserQuestion:

```
question: "Restart your terminal after install, then confirm."
options: [
  { label: "Done", description: "I've installed the version manager and restarted terminal" },
  { label: "Problem", description: "Something went wrong" }
]
```

After user confirms → re-run `$SCRIPTS/install-node.sh <chosenManager>` — this
time the manager is available, so it installs Node automatically.

**If "Direct install"** → show platform-specific instructions from
`reference.md` "Direct Node.js Install" table.

After user confirms → re-run detect-environment.sh to get new paths, verify
version >= 24.

**If "Already installed"** → re-run detect-environment.sh, verify version >= 24.

**CRITICAL: Do NOT proceed until Node >= 24 is confirmed.** If the old Node is
still first in PATH after version manager install (e.g. system Node shadows the
new one), re-run `$SCRIPTS/detect-environment.sh` to refresh paths. Only
continue when `install-node.sh` returns `already_done` or `installed` with
version >= 24.
