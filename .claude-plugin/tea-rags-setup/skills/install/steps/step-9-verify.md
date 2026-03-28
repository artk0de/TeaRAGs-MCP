# Step 9: Verify

Run: `claude mcp get tea-rags`

Check output for "connected" status.

- If connected → SUCCESS. Show summary: "TeaRAGs setup complete! Configuration:
  - Embedding: {provider}
  - Qdrant: {mode}
  - Git analytics: {enabled/disabled}

  Restart your Claude Code session to activate the MCP server. After restart,
  run `/tea-rags:index` to index your codebase."

- If not connected → AskUserQuestion: "MCP server not yet connected. This
  usually resolves after restarting the session. Restart Claude Code and run
  `/tea-rags-setup:install` again to verify."

Mark all steps completed in progress.
