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

Save progress `mcpScope: "user"` / `"project"`.

## 8a-check: Existing config

Before assembling: `claude mcp get tea-rags`. Already configured →
AskUserQuestion:

```
question: "tea-rags MCP server is already configured. Replace with new settings?"
options: [
  { label: "Replace", description: "Overwrite existing configuration" },
  { label: "Keep", description: "Keep existing configuration, skip to verification" }
]
```

"Keep" → Step 9. "Replace" → `claude mcp remove tea-rags` first, continue.

## 8b: Assemble env vars

From progress, ALL env vars in `reference.md` "All Env Vars for MCP
Configuration" table. Omit null / missing keys (except `GIT_ADAPTER` — always).

## 8c: Dispatch MCP integrator agent

Agent tool → `${CLAUDE_PLUGIN_ROOT}/agents/mcp-server-integrator.md`, prompt
like:

```
Agent tool:
  description: "Configure tea-rags MCP server"
  prompt: |
    Add the tea-rags MCP server with the following configuration:

    Server name: tea-rags
    Scope: <user|project>
    Command: tea-rags server
    Environment variables (include all non-null values from progress):
      EMBEDDING_PROVIDER=<value>
      EMBEDDING_BASE_URL=<embeddingBaseUrl — llama-server only>
      EMBEDDING_FALLBACK_URL=<embeddingFallbackUrl — llama-server, if set>
      EMBEDDING_API_KEY=<embeddingApiKey — llama-server, if set>
      EMBEDDING_MODEL=<embeddingModel — llama-server, if set>
      QDRANT_URL=<value or omit if embedded>
      <all tuneValues keys>=<values>
      TRAJECTORY_GIT_ENABLED=<value>
      GIT_ADAPTER=<gitAdapter from progress — ALWAYS include, "git" too>

    Use `claude mcp add tea-rags -s <scope> ...` to configure.
    After adding, verify with `claude mcp get tea-rags`.
    Report the full verification output.
```

Agent builds + runs `claude mcp add`, verifies connected via `claude mcp get`.

**Agent fails** (permission denied, config locked, `claude` not in PATH) →
manual: show full `claude mcp add` command, AskUserQuestion:

```
question: "Automatic MCP configuration failed. Run this command manually, then confirm."
options: [
  { label: "Done", description: "I've run the command" },
  { label: "Problem", description: "Something went wrong" }
]
```
