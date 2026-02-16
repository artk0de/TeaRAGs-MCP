---
title: Prompts
sidebar_position: 3
---

Reusable text templates with parameters that AI assistants can invoke via MCP. Define once, use everywhere — no code changes needed.

## How It Works

1. Create `prompts.json` with template definitions
2. MCP server registers them as available prompts
3. AI assistant (Claude Code, etc.) can invoke them by name with parameters
4. Template renders into a structured instruction for the AI

## Use Cases

- Standardize team workflows (e.g., "analyze collection before optimization")
- Create project-specific search patterns (e.g., "find code related to ticket X")
- Build guided wizards for complex operations

## Setup

1. **Create a prompts configuration file** (e.g., `prompts.json` in the project root). See `prompts.example.json` for example configurations.

2. **Configure the server** (optional — only needed for custom path):

```json
{
  "mcpServers": {
    "qdrant": {
      "env": {
        "PROMPTS_CONFIG_FILE": "/custom/path/to/prompts.json"
      }
    }
  }
}
```

3. **Use prompts** in your AI assistant:

```bash
/mcp__tea-rags-mcp__find_similar_docs papers "neural networks" 10
```

## Template Syntax

Templates use `{{variable}}` placeholders:

- Required arguments must be provided
- Optional arguments use defaults if not specified

## Example Prompts

See `prompts.example.json` for ready-to-use prompts including:

- `setup_rag_collection` — create RAG-optimized collections
- `analyze_collection` — collection insights and recommendations
- `compare_search_methods` — semantic vs hybrid search comparison
