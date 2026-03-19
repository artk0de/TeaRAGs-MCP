# CLI Executable Design

## Problem

tea-rags MCP server is started via raw node path (`node build/index.js`),
requiring users to know the exact path. No CLI interface exists for subcommands,
config files, or future extensibility.

## Solution

Add a proper CLI layer with yargs, YAML config support, and subcommand
architecture.

## Architecture

### Directory Structure

```
src/cli/
├── index.ts          # Entrypoint with shebang, yargs setup
├── commands/
│   └── server.ts     # tea-rags server command
└── config/
    └── loader.ts     # YAML config discovery and merge
```

### Layer Rules

`src/cli/` follows the same import rules as `src/mcp/`:

- May import from `src/core/api/public/` and `src/core/contracts/`
- Must NOT import from `src/core/domains/`, `src/core/adapters/`,
  `src/core/infra/`

### Commands

| Command              | Description                                         |
| -------------------- | --------------------------------------------------- |
| `tea-rags` (no args) | Show help                                           |
| `tea-rags server`    | Start MCP server (stdio default, `--http` for HTTP) |

### Config System

**Priority (highest to lowest):**

1. CLI flags
2. `.tea-rags/config.yml` (project-level)
3. `~/.tea-rags/config.yml` (global)
4. Environment variables
5. Defaults

**Config format:** YAML only.

**Discovery:** Look for `.tea-rags/config.yml` starting from cwd upward, then
`~/.tea-rags/config.yml`.

### package.json Changes

```json
{
  "bin": {
    "tea-rags": "build/cli/index.js"
  }
}
```

### Dependencies

- `yargs` + `@types/yargs` — CLI framework with subcommands
- `yaml` — YAML parser (YAML 1.2, native TS types)

### Backward Compatibility

- `src/index.ts` remains as direct MCP server entry — existing configs with
  `"args": ["build/index.js"]` continue to work
- New way: `"command": "npx", "args": ["-y", "tea-rags", "server"]`
- Or after global install: `"command": "tea-rags", "args": ["server"]`

## Scope

This spec covers only the `server` subcommand and config loading.
`plugin install/update` is a separate task (tea-rags-mcp-ndh0).
