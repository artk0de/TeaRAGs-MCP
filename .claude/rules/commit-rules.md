# Commit Rules

## Commit Types (MANDATORY)

| Type       | When to use                             | Default bump |
| ---------- | --------------------------------------- | ------------ |
| `feat`     | New capability that didn't exist before | minor        |
| `improve`  | Enhancement to existing functionality   | patch        |
| `fix`      | Bug fix                                 | patch        |
| `perf`     | Performance improvement                 | patch        |
| `refactor` | Code restructuring, no behavior change  | patch        |
| `docs`     | Documentation only                      | patch        |
| `test`     | Adding/updating tests                   | none         |
| `chore`    | Build, dependencies, tooling            | none         |
| `ci`       | CI/CD changes                           | none         |
| `style`    | Code style/formatting                   | none         |
| `build`    | Build system changes                    | none         |

**feat vs improve**: `feat` = new capability. `improve` = enhancement to
existing.

## Scope-Based Versioning (MANDATORY)

Scope determines version bump. **Always use a scope.**

**Public + Functional** (feat -> minor): `api`, `mcp`, `contracts`, `types`,
`drift`, `explore`, `rerank`, `hybrid`, `trajectory`, `signals`, `presets`,
`filters`, `ingest`, `pipeline`, `chunker`

**Infrastructure** (feat -> patch): `onnx`, `embedding`, `embedded`, `adapters`,
`qdrant`, `git`, `config`, `factory`, `bootstrap`, `debug`, `logs`

**Non-release** (always none): `test`, `beads`, `scripts`, `ci`, `website`,
`deps`

A PostToolUse hook (`check-release-scope.sh`) warns when a commit uses an
unknown scope. When adding a new scope, update `.releaserc.json` and the scope
tables in `CONTRIBUTING.md`.

## BREAKING CHANGE footer (MANDATORY)

Add `BREAKING CHANGE:` footer to commit messages when:

- Environment variable names, defaults, or semantics change
- Configuration file format or location changes
- CLI flags or arguments change
- Package name changes
- Data directory paths change
- Any change that **requires user action** (update config, re-run setup, etc.)

Do NOT use BREAKING CHANGE for:

- Internal refactoring that doesn't affect user-facing behavior
- New features that are additive (no existing behavior changes)
- Bug fixes (unless the buggy behavior was documented/relied upon)

Format:

```text
feat(config): add embedded Qdrant support

BREAKING CHANGE: QDRANT_URL default changed from http://localhost:6333 to autodetect.
Users with Docker Qdrant should set QDRANT_URL=http://localhost:6333 explicitly.
```
