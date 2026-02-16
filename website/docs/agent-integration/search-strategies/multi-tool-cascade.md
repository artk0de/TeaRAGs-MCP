---
title: Multi-Tool Cascade
sidebar_position: 3
---

# Combining with Other Search Tools {#multi-tool-strategy}

Semantic search is powerful for discovery, but real engineering workflows require multiple tools. TeaRAGs is designed to work alongside structural analysis ([tree-sitter](https://github.com/nicobailey/tree-sitter-mcp)) and exact text search ([ripgrep](https://github.com/nicobailey/ripgrep-mcp)) — each covering a different axis of code understanding.

## The Three-Tool Cascade

| Axis | Tool | Strength | Weakness |
|------|------|----------|----------|
| **Meaning / intent** | TeaRAGs | Finds code by concept without knowing names | Can't find exact strings or analyze structure |
| **Structure / shape** | tree-sitter MCP | Classes, methods, signatures, inheritance | Can't search by meaning or find text patterns |
| **Exact text / tokens** | ripgrep MCP | Exact strings, TODOs, flags, config keys | Can't understand intent or code structure |

The cascade works top-down: **intent → structure → exact match**.

## When to Use Which External Tool

| You need to... | Tool | Example |
|----------------|------|---------|
| Understand how a subsystem works | TeaRAGs `search_code` | "How does job status transition work?" |
| Find related logic without knowing names | TeaRAGs `search_code` | "Where is retry logic implemented?" |
| Analyze churn, ownership, tech debt | TeaRAGs `semantic_search` | `rerank: "hotspots"`, `metaOnly: true` |
| List methods of a class | tree-sitter `query_code` | `query_key: "methods"`, filter by file |
| Inspect method signatures and arguments | tree-sitter `analyze_code_structure` | Get full class/method/field overview |
| Find all callers of a specific method | ripgrep `search` | `pattern: "UpdateStatus.call"` |
| Find feature flags or env vars | ripgrep `search` | `pattern: "feature_available\\?\\(:job_status"` |
| Find TODOs, FIXMEs, deprecation notices | ripgrep `search` | `pattern: "TODO\|FIXME\|DEPRECATED"` |
| Verify a string is not hardcoded anywhere | ripgrep `count-matches` | `pattern: "secret_key"` → expect 0 |

## Example: Investigating an Enterprise Service

Consider an enterprise service handling workflow job status transitions — a Ruby class with authorization, requirement checks, automations, activity feed events, and analytics tracking. Here's how each tool contributes to understanding it:

### Step 1 — TeaRAGs: Discover by intent

Ask a question about behavior — not about class names:

> "How does workflow job status update work?"

TeaRAGs finds the service by meaning — even though the query says "workflow job status update" and the class is named `Pipelines::Jobs::UpdateStatus`. No name guessing required. Results include related services: `FinishRequirements`, `ConvertLinksToAutomoved`, `Automations::Run`.

### Step 2 — tree-sitter: Understand structure

After finding the file, use tree-sitter to get a structural overview — all methods, their signatures, and line positions — without reading the entire file:

```text
analyze_code_structure("app/services/workflow/pipelines/jobs/update_status.rb")
→ class UpdateStatus (line 3-114)
    ├── perform()                    (line 19-79)
    ├── raise_need_confirmation_error!(job, new_status)  (line 81-83)
    ├── send_skipped_automations(automations_result)      (line 85-91)
    ├── update_completed_fields!(job, old_status, new_status) (line 93-105)
    ├── completing_job?(old_status, new_status)           (line 107-109)
    └── uncompleting_job?(old_status, new_status)         (line 111-113)
```

Now you know the method layout without reading 114 lines.

### Step 3 — ripgrep: Find exact references

To find all callers of this service across the codebase:

```text
ripgrep search: "UpdateStatus.call" → 12 matches in controllers, other services, tests
ripgrep search: "NeedConfirmationError" → 3 matches (definition + 2 rescue sites)
ripgrep search: "feature_available?(:job_status_completed" → 1 match (this file only)
```

## Decision Shortcut

If unsure which tool to use, apply this order:

1. **Meaning / intent / behavior?** → TeaRAGs
2. **Classes / methods / signatures?** → tree-sitter
3. **Exact text / flags / TODO / config?** → ripgrep
4. **Need to read actual code?** → filesystem (read file)

## Multi-Tool Anti-Patterns

| Anti-pattern | Why it's wrong | Correct approach |
|-------------|---------------|-----------------|
| Using ripgrep to understand architecture | Grep matches syntax, not meaning | Use TeaRAGs for "how does X work?" |
| Using TeaRAGs to find exact method names | Semantic search may miss exact tokens | Use ripgrep for `"ClassName.method_name"` |
| Using tree-sitter for text search | Tree-sitter parses structure, not content | Use ripgrep for strings, comments, flags |
| Skipping tree-sitter and reading full files | Wastes tokens on large files | Use tree-sitter for structure overview first |
