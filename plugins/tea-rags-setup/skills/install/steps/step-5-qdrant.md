# Step 5: Choose & Setup Qdrant

AskUserQuestion:

```
question: "Choose Qdrant deployment mode"
options: [
  { label: "Embedded", description: "Recommended. Built-in, zero configuration. Starts automatically with tea-rags." },
  { label: "Docker", description: "Separate container. Requires Docker." },
  { label: "Native", description: "System install via {brew|apt|binary}." }
]
```

Run: `$SCRIPTS/setup-qdrant.sh <mode> <platform>` (`"linux"` for WSL)

**Interpret result:**

- `already_done` / `installed` → save qdrantMode + url to progress
- exit 2 (Docker not found) → AskUserQuestion: "Docker is required but not
  installed. Install Docker Desktop and respond when done." Confirmed → re-run.
- exit 1, stderr "daemon is not running" → AskUserQuestion: "Docker is installed
  but not running. Start Docker Desktop and confirm." Confirmed → re-run.
- other exit code 1 → show stderr, AskUserQuestion:
  ```
  question: "Qdrant setup failed. Choose an alternative."
  options: [
    { label: "Retry", description: "Try the same mode again" },
    { label: "Embedded", description: "Switch to embedded mode (zero config)" },
    { label: "Native", description: "Switch to native binary install" }
  ]
  ```
