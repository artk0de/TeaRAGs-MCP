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

Run: `$SCRIPTS/setup-qdrant.sh <mode> <platform>` (use `"linux"` for WSL)

**Interpret result:**

- `already_done` or `installed` → save qdrantMode and url to progress
- exit code 2 (Docker not found) → AskUserQuestion: "Docker is required but not
  installed. Install Docker Desktop and respond when done." After confirm →
  re-run.
- exit code 1 with stderr "daemon is not running" → AskUserQuestion: "Docker is
  installed but not running. Start Docker Desktop and confirm." After confirm →
  re-run.
- other exit code 1 → show stderr, AskUserQuestion:
  ```
  question: "Qdrant setup failed. Choose an alternative."
  options: [
    { label: "Retry", description: "Try the same mode again" },
    { label: "Embedded", description: "Switch to embedded mode (zero config)" },
    { label: "Native", description: "Switch to native binary install" }
  ]
  ```
