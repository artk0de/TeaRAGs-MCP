# Step 3: Install tea-rags

Run: `$SCRIPTS/install-tea-rags.sh <packageManager> <npmPath>`

**Interpret result:**

- `already_done` → show version, AskUserQuestion:
  ```
  question: "tea-rags v{version} is already installed."
  options: [
    { label: "Keep", description: "Continue with current version" },
    { label: "Update", description: "Update to latest version" }
  ]
  ```
  "Keep" → update progress → Step 4. "Update" → re-run install script (does
  `npm install -g tea-rags@latest`).
- `installed` → update progress
- `error` → stderr has "EACCES" or "permission denied" → AskUserQuestion:
  ```
  question: "npm install failed due to permissions. How to fix?"
  options: [
    { label: "Use sudo", description: "Run: ! sudo npm install -g tea-rags" },
    { label: "Fix npm prefix", description: "Set user-writable prefix: ! npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:$PATH" },
    { label: "Skip", description: "I'll fix this myself and re-run setup" }
  ]
  ```
  Other errors → show stderr, suggest re-running `/tea-rags-setup:install`
