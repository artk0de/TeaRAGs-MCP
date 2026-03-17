---
title: Ignoring Files
sidebar_position: 3.5
---

import AiQuery from '@site/src/components/AiQuery'; import MermaidTeaRAGs from
'@site/src/components/MermaidTeaRAGs';

# Ignoring Files

TeaRAGs gives you fine-grained control over which files enter the search index.
This page explains every ignore mechanism, how they stack, and what happens when
ignore rules change between reindexes.

## How Ignore Rules Stack

TeaRAGs loads ignore patterns from multiple sources **in order**. Patterns are
cumulative — if a file matches **any** source, it is excluded.

<MermaidTeaRAGs>
{`
flowchart LR
    subgraph files["📂 Ignore Sources (loaded in order)"]
        G[".gitignore"]
        D[".dockerignore"]
        N[".npmignore"]
        C[".contextignore"]
        CL[".contextignore.local"]
    end

    subgraph config["⚙️ Config Patterns"]
        BI["Built-in defaults<br/><small>node_modules, dist, .git…</small>"]
        ENV["CODE_CUSTOM_IGNORE<br/><small>env variable</small>"]
    end

    subgraph result["🔍 Scanner Decision"]
        Check{"File matches<br/>any pattern?"}
        Skip["❌ Excluded"]
        Index["✅ Indexed"]
    end

    files --> Check
    config --> Check
    Check -- yes --> Skip
    Check -- no --> Index

`} </MermaidTeaRAGs>

### Loading order

| #   | Source                 | Syntax                | Purpose                                      |
| --- | ---------------------- | --------------------- | -------------------------------------------- |
| 1   | `.gitignore`           | gitignore             | Respect your existing VCS exclusions         |
| 2   | `.dockerignore`        | gitignore             | Skip Docker build artifacts                  |
| 3   | `.npmignore`           | gitignore             | Skip npm publish exclusions                  |
| 4   | `.contextignore`       | gitignore             | **TeaRAGs-specific** project exclusions      |
| 5   | `.contextignore.local` | gitignore             | **Personal** overrides (add to `.gitignore`) |
| 6   | Built-in defaults      | glob                  | Always excluded (see below)                  |
| 7   | `CODE_CUSTOM_IGNORE`   | comma-separated globs | Runtime overrides via env                    |

All files use
[gitignore syntax](https://git-scm.com/docs/gitignore#_pattern_format) and are
read from the project root.

## Ignore Sources in Detail

### .gitignore (automatic)

Your existing `.gitignore` is loaded automatically. No configuration needed. If
Git ignores a file, TeaRAGs ignores it too.

### .contextignore (project-level)

Create a `.contextignore` file in your project root for search-index-specific
exclusions. Useful when you want files tracked by Git but excluded from semantic
search.

```gitignore
# Test files add noise to code search results
**/test/**
**/*.test.ts
**/*.spec.ts

# Generated code — semantically meaningless
*.generated.ts
**/generated/**
**/proto/gen/**

# Fixtures and mocks
**/fixtures/**
**/mocks/**
**/__tests__/**

# Large data files
**/migrations/**
**/seeds/**
```

:::tip `.contextignore` is the recommended way to customize which files TeaRAGs
indexes. It lives in source control and applies to everyone on the team. :::

### .contextignore.local (personal overrides)

Same syntax as `.contextignore`, but for personal preferences. Add
`.contextignore.local` to your `.gitignore` so it stays local:

```gitignore
# .contextignore.local — not committed
# I'm working on auth, exclude everything else to speed up reindexing
src/billing/**
src/notifications/**
src/analytics/**
```

### Built-in defaults

These patterns are always applied regardless of your configuration:

| Pattern                                      | What it excludes          |
| -------------------------------------------- | ------------------------- |
| `node_modules/**`                            | Node.js dependencies      |
| `dist/**`, `build/**`, `out/**`, `target/**` | Build outputs             |
| `coverage/**`, `.nyc_output/**`              | Test coverage             |
| `.git/**`, `.svn/**`, `.hg/**`               | Version control internals |
| `.vscode/**`, `.idea/**`                     | IDE configuration         |
| `__pycache__/**`, `.cache/**`                | Runtime caches            |
| `*.min.js`, `*.min.css`, `*.bundle.js`       | Minified/bundled assets   |
| `*.map`, `*.log`                             | Source maps and logs      |
| `.env`, `.env.*`                             | Environment secrets       |

### CODE_CUSTOM_IGNORE (environment variable)

Add patterns at runtime without creating a file:

```bash
export CODE_CUSTOM_IGNORE="**/*.generated.ts,**/vendor/**,**/third_party/**"
```

Patterns are comma-separated globs. Useful in CI/CD or when testing different
ignore configurations.

## Dynamic Ignore Tracking

TeaRAGs detects when ignore rules change between reindexes and updates the index
accordingly. No manual intervention needed.

### How it works

When you run `reindex_changes`, TeaRAGs scans files using the **current** ignore
rules and compares with the previous snapshot:

| Scenario                 | Detection                                   | Action                          |
| ------------------------ | ------------------------------------------- | ------------------------------- |
| File added to ignore     | File is in snapshot but not in current scan | Chunks removed from index       |
| File removed from ignore | File is in current scan but not in snapshot | File chunked and added to index |
| File deleted from disk   | File is in snapshot but not on disk         | Chunks removed from index       |
| New file created         | File on disk but not in snapshot            | File chunked and added to index |

TeaRAGs distinguishes between files that were **truly deleted** and files that
were **newly ignored** (still on disk but excluded by updated patterns). Both
are reported in the reindex stats:

```
Incremental re-index complete:
- Files added: 3
- Files modified: 1
- Files deleted: 0
- Files newly ignored: 5
- Files newly unignored: 2
- Chunks added: 12
- Duration: 1.2s
```

### Common workflows

**Adding test files to ignore after initial index:**

1. Index the codebase (test files included)
2. Add `**/*.test.ts` to `.contextignore`
3. Run reindex — test file chunks are automatically removed

<AiQuery>Update the search index with my recent changes</AiQuery>

**Removing an overly broad pattern:**

1. `.contextignore` has `**/utils/**` — too aggressive
2. Remove or narrow the pattern
3. Run reindex — previously excluded utils are now indexed

**Switching .contextignore between branches:**

If branches have different `.contextignore` files, reindexing after a branch
switch will automatically add/remove the right files.

## File Extension Filtering

Beyond ignore patterns, TeaRAGs only indexes files with recognized source-code
extensions. Files with unknown extensions are silently skipped.

To add non-standard extensions:

```bash
export CODE_CUSTOM_EXTENSIONS=".proto,.graphql,.prisma,.hcl"
```

This is additive — built-in extensions are always included.

## Best Practices

### 1. Start permissive, then narrow

Index everything first, evaluate search quality, then add exclusions for noisy
results. It's easier to exclude than to discover what you missed.

### 2. Use .contextignore for team-wide rules

Commit `.contextignore` to source control. The whole team gets consistent search
results.

### 3. Use .contextignore.local for personal scope

Working on a specific feature? Exclude unrelated directories in
`.contextignore.local` to speed up reindexing. Don't commit it.

### 4. Exclude generated code

Generated files (protobuf, GraphQL codegen, ORM models) add noise without
semantic value. Always exclude them:

```gitignore
# .contextignore
**/generated/**
**/*.generated.*
**/proto/gen/**
```

### 5. Don't over-exclude

Excluding test files improves precision for "how does X work?" queries but loses
coverage for "how is X tested?" queries. Consider your use case before excluding
entire directories.

### 6. Rely on incremental reindex

After changing ignore patterns, a simple reindex picks up the changes
automatically. No need for a full reindex.

<AiQuery>Update the search index with my recent changes</AiQuery>

## Troubleshooting

### File I expect is not indexed

1. Check if it matches any pattern in `.gitignore`, `.contextignore`, or
   `CODE_CUSTOM_IGNORE`
2. Verify the file extension is supported or added via `CODE_CUSTOM_EXTENSIONS`
3. Run index status to confirm the index is up to date

<AiQuery>Show me stats for the current index</AiQuery>

### Files I excluded still appear in search

Run a reindex to apply the updated ignore rules:

<AiQuery>Update the search index with my recent changes</AiQuery>

The reindex will remove chunks for newly ignored files.

### Too many files indexed, slow queries

Add aggressive exclusions to `.contextignore`:

```gitignore
**/vendor/**
**/third_party/**
**/migrations/**
**/*.min.js
**/*.bundle.js
```

Every excluded file reduces index size and improves query speed.

## Next Steps

- [Indexing Repositories](/usage/indexing-repositories) — full indexing workflow
  and configuration
- [Filters](/usage/filters) — narrow search results by metadata after indexing
- [Query Modes](/usage/query-modes) — semantic, hybrid, and code search
