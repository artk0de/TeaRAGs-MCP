# Step 8: Configure MCP

## 8a: Choose scope

AskUserQuestion:

```
question: "MCP server scope — where should tea-rags be available?"
options: [
  { label: "Global (user)", description: "Available in all projects. Recommended for personal use." },
  { label: "Project", description: "Only for the current project. Creates .mcp.json in project root." }
]
```

Save scope choice to progress (`mcpScope: "user"` or `"project"`).

## 8a-check: Existing config

Before assembling, run `claude mcp get tea-rags`. If tea-rags is already
configured → AskUserQuestion:

```
question: "tea-rags MCP server is already configured. Replace with new settings?"
options: [
  { label: "Replace", description: "Overwrite existing configuration" },
  { label: "Keep", description: "Keep existing configuration, skip to verification" }
]
```

If "Keep" → skip to Step 9. If "Replace" → run `claude mcp remove tea-rags`
first, then continue.

## 8b: Assemble env vars

From progress, include ALL env vars listed in `reference.md` "All Env Vars for
MCP Configuration" table. Omit any key that is null or missing.

## 8c: Dispatch MCP integrator agent

Use the Agent tool to dispatch
`${CLAUDE_PLUGIN_ROOT}/agents/mcp-server-integrator.md` with a prompt like:

```
Agent tool:
  description: "Configure tea-rags MCP server"
  prompt: |
    Add the tea-rags MCP server with the following configuration:

    Server name: tea-rags
    Scope: <user|project>
    Command: npx tea-rags server
    Environment variables (include all non-null values from progress):
      EMBEDDING_PROVIDER=<value>
      QDRANT_URL=<value or omit if embedded>
      <all tuneValues keys>=<values>
      TRAJECTORY_GIT_ENABLED=<value>
      TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=<value or omit>

    Use `claude mcp add tea-rags -s <scope> ...` to configure.
    After adding, verify with `claude mcp get tea-rags`.
    Report the full verification output.
```

The agent handles: building the correct `claude mcp add` command, executing it,
and verifying via `claude mcp get` that the server shows as connected.

**If the agent fails** (e.g. permission denied, config locked, `claude` not in
PATH) → fall back to manual configuration. Show the user the full
`claude mcp add` command and AskUserQuestion:

```
question: "Automatic MCP configuration failed. Run this command manually, then confirm."
options: [
  { label: "Done", description: "I've run the command" },
  { label: "Problem", description: "Something went wrong" }
]
```
