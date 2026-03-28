# Plugin Restructuring Design

**Date**: 2026-03-27 **Status**: Approved **Scope**: `plugin/` →
`.claude-plugin/tea-rags/` + `.claude-plugin/setup/`

## Problem

All plugin assets (search skills, setup wizard, rules, hooks, scripts) live in a
single `plugin/` directory as one monolithic plugin `tea-rags@artk0de`. The
setup skill is a separate concern from the core search/generation skills. Users
should be able to install them independently. The marketplace name `artk0de` is
a personal account, not the product name.

## Solution

Split into two plugins under `.claude-plugin/` directory. Rename marketplace
from `artk0de` to `tea-rags`. Keep author as `artk0de`.

## Target Structure

```
.claude-plugin/
  tea-rags/                              # tea-rags@tea-rags (core)
    .claude-plugin/
      plugin.json
    skills/
      explore/SKILL.md
      research/SKILL.md
      bug-hunt/SKILL.md
      pattern-search/SKILL.md
      refactoring-scan/SKILL.md
      data-driven-generation/
        SKILL.md
        strategies/
          conservative.md
          defensive.md
          stabilization.md
          standard.md
      index/SKILL.md
      force-reindex/SKILL.md
    rules/
      search-cascade.md
      post-search-validation.md
    scripts/
      inject-rules.sh
      enforce-tearags-search.sh
  setup/                                 # setup@tea-rags (installer)
    .claude-plugin/
      plugin.json
    skills/
      setup/SKILL.md
    scripts/
      setup/
        unix/
          progress.sh
          detect-environment.sh
          install-node.sh
          install-tea-rags.sh
          install-ollama.sh
          setup-qdrant.sh
          tune.sh
          analyze-project.sh
          configure-mcp.sh
        windows/
          progress.ps1
          detect-environment.ps1
          install-node.ps1
          install-tea-rags.ps1
          install-ollama.ps1
          setup-qdrant.ps1
          tune.ps1
          analyze-project.ps1
          configure-mcp.ps1
```

## Plugin Manifests

### tea-rags/.claude-plugin/plugin.json

```json
{
  "name": "tea-rags",
  "description": "Data-driven code generation strategies powered by TeaRAGs git signals",
  "version": "0.11.0",
  "author": { "name": "artk0de" },
  "keywords": ["code-generation", "git-signals", "strategies", "search"],
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/enforce-tearags-search.sh"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/inject-rules.sh"
          }
        ]
      }
    ]
  }
}
```

### setup/.claude-plugin/plugin.json

```json
{
  "name": "setup",
  "description": "Automated TeaRAGs installation wizard — Node.js, embedding providers, Qdrant, MCP configuration",
  "version": "0.1.0",
  "author": { "name": "artk0de" },
  "keywords": ["setup", "installation", "wizard"]
}
```

## Marketplace Manifest

### .claude-plugin/marketplace.json

The marketplace definition lives in the repo, not in settings.json.

**Current:**

```json
{
  "name": "artk0de",
  "owner": {
    "name": "Artur Korochanskii",
    "email": "art2rik.desperado@gmail.com"
  },
  "plugins": [
    {
      "name": "tea-rags",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/artk0de/TeaRAGs-MCP.git",
        "path": "plugin",
        "ref": "main"
      },
      "description": "...",
      "version": "0.1.0",
      "keywords": [...]
    }
  ]
}
```

**Target:**

```json
{
  "name": "tea-rags",
  "owner": {
    "name": "Artur Korochanskii",
    "email": "art2rik.desperado@gmail.com"
  },
  "plugins": [
    {
      "name": "tea-rags",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/artk0de/TeaRAGs-MCP.git",
        "path": ".claude-plugin/tea-rags",
        "ref": "main"
      },
      "description": "Data-driven code generation strategies powered by TeaRAGs git signals",
      "version": "0.11.0",
      "keywords": [
        "code-generation",
        "git-signals",
        "strategies",
        "search",
        "tea-rags"
      ]
    },
    {
      "name": "setup",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/artk0de/TeaRAGs-MCP.git",
        "path": ".claude-plugin/setup",
        "ref": "main"
      },
      "description": "Automated TeaRAGs installation wizard",
      "version": "0.1.0",
      "keywords": ["setup", "installation", "wizard"]
    }
  ]
}
```

## Settings Changes

### ~/.claude/settings.json

**Remove:**

```json
{
  "extraKnownMarketplaces": {
    "artk0de": { ... }
  },
  "enabledPlugins": {
    "tea-rags@artk0de": true
  }
}
```

**Add:**

```json
{
  "extraKnownMarketplaces": {
    "tea-rags": {
      "source": {
        "source": "github",
        "repo": "artk0de/TeaRAGs-MCP"
      },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "tea-rags@tea-rags": true,
    "setup@tea-rags": true
  }
}
```

## Migration Steps

1. Create `.claude-plugin/tea-rags/` and `.claude-plugin/setup/` directories
2. Move `plugin/skills/` (except setup) → `.claude-plugin/tea-rags/skills/`
3. Move `plugin/rules/` → `.claude-plugin/tea-rags/rules/`
4. Move `plugin/scripts/inject-rules.sh` and `enforce-tearags-search.sh` →
   `.claude-plugin/tea-rags/scripts/`
5. Move `plugin/skills/setup/` → `.claude-plugin/setup/skills/setup/`
6. Move `plugin/scripts/setup/` → `.claude-plugin/setup/scripts/setup/`
7. Create both `plugin.json` files
8. Delete `plugin/` directory
9. Update `~/.claude/settings.json` (marketplace + enabled plugins)
10. Update `.claude/rules/plugin-versioning.md` to reflect new paths
11. Clear old cache: `rm -rf ~/.claude/plugins/cache/artk0de/`

## What Does NOT Change

- GitHub repo stays `artk0de/TeaRAGs-MCP`
- SKILL.md content stays the same (paths use `${CLAUDE_PLUGIN_ROOT}`)
- Hook scripts stay the same
- `.claude/CLAUDE.md` and `.claude/rules/` project instructions — no changes
- npm package `tea-rags` — unrelated to plugins

## Risks

- **Cache invalidation**: old `artk0de` cache must be cleared, otherwise Claude
  Code may load stale plugin
- **Session restart required**: after settings.json change, session must restart
  for new plugins to load
- **${CLAUDE_PLUGIN_ROOT}**: resolves to the plugin's root directory — since we
  move files maintaining the same relative structure, all
  `${CLAUDE_PLUGIN_ROOT}` references continue to work

## Implementation Tasks

1. Create directory structure under `.claude-plugin/`
2. Move tea-rags plugin files (skills, rules, scripts, plugin.json)
3. Move setup plugin files (skills, scripts, plugin.json)
4. Delete `plugin/` directory
5. Update `.claude-plugin/marketplace.json` (name, plugins, paths)
6. Update `~/.claude/settings.json` (marketplace key + enabled plugins)
7. Update `.claude/rules/plugin-versioning.md` to reflect new paths
8. Clear old cache: `rm -rf ~/.claude/plugins/cache/artk0de/`
9. Verify plugins load after session restart
