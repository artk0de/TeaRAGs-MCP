# Step 2: Install Node.js

Run: `$SCRIPTS/install-node.sh <versionManager>`

**Interpret result:**

- `already_done` → update progress → Step 3
- `installed` → update nodePath in progress → Step 3
- `manual_required` (exit code 2) → `currentVersion` non-null → include in
  message (e.g. "Node.js 24+ required, found v18.19.0"). AskUserQuestion:
  ```
  question: "Node.js 24+ is required{. Found vX.Y.Z — upgrade needed | but not installed}. How would you like to install it?"
  options: [
    { label: "Version manager", description: "Install fnm/volta/nvm first, then Node.js through it (recommended for developers)" },
    { label: "Direct install", description: "Install Node.js directly from nodejs.org or via system package manager" },
    { label: "Already installed", description: "I've already installed Node.js 24+ — just re-detect" }
  ]
  ```

**"Version manager"** → filter by platform via `reference.md` tables →
AskUserQuestion w/ platform-specific options. Windows + `hasWinget` false →
manual download URLs instead of winget commands.

User picks manager → suggest `!` prefix so it runs in-session. Example:

"To install, type in the prompt: `! winget install CoreyButler.NVMforWindows`"

Then AskUserQuestion:

```
question: "Restart your terminal after install, then confirm."
options: [
  { label: "Done", description: "I've installed the version manager and restarted terminal" },
  { label: "Problem", description: "Something went wrong" }
]
```

Confirmed → re-run `$SCRIPTS/install-node.sh <chosenManager>` (manager now
available → installs Node).

**"Direct install"** → platform instructions from `reference.md` "Direct Node.js
Install" table. Confirmed → re-run detect-environment.sh for new paths, verify
version >= 24.

**"Already installed"** → re-run detect-environment.sh, verify version >= 24.

**CRITICAL: Do NOT proceed until Node >= 24 confirmed.** Old Node still first in
PATH (system Node shadows new) → re-run `$SCRIPTS/detect-environment.sh`.
Continue only when `install-node.sh` returns `already_done` or `installed` w/
version >= 24.
