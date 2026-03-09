# Contributing

Thank you for your interest in contributing to TeaRAGs MCP!

## Getting Started

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/TeaRAGs-MCP.git
cd TeaRAGs-MCP
npm install

# 2. Create feature branch
git checkout -b feat/your-feature-name

# 3. Make changes, add tests

# 4. Verify
npm test -- --run
npm run type-check
npm run build

# 5. Commit with conventional format
git commit -m "feat(search): add new reranking preset"
```

## Development Commands

| Command                        | Purpose                        |
| ------------------------------ | ------------------------------ |
| `npm run build`                | Build for production           |
| `npm run dev`                  | Development with auto-reload   |
| `npm test`                     | Run test suite                 |
| `npm run test:ui`              | Tests with UI                  |
| `npm run test:coverage`        | Coverage report                |
| `npm run test:providers`       | Provider verification          |
| `npm run type-check`           | TypeScript validation          |
| `npm run tune`                 | Auto-calibrate all parameters  |
| `npm run benchmark-embeddings` | Calibrate embedding parameters |

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
with scope-based versioning rules.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Commit Types

| Type       | When to use                                  | Default bump |
| ---------- | -------------------------------------------- | ------------ |
| `feat`     | New capability that didn't exist before       | minor        |
| `improve`  | Enhancement to existing functionality         | patch        |
| `fix`      | Bug fix                                       | patch        |
| `perf`     | Performance improvement                       | patch        |
| `refactor` | Code restructuring without behavior change    | patch        |
| `docs`     | Documentation only                            | patch        |
| `test`     | Adding/updating tests                         | none         |
| `chore`    | Build, dependencies, tooling                  | none         |
| `ci`       | CI/CD changes                                 | none         |
| `style`    | Code style/formatting                         | none         |
| `build`    | Build system changes                          | none         |

### feat vs improve

Use `feat` when introducing a **new capability** — something that didn't exist before.
Use `improve` when **enhancing existing behavior** — better messages, UX tweaks, defaults.

```bash
# feat — new capability
feat(search): add hybrid BM25+dense fusion
feat(chunker): add MarkdownChunker with frontmatter support
feat(onnx): implement daemon server with Unix socket

# improve — enhancement to existing
improve(search): better error messages for invalid filters
improve(onnx): clearer calibration progress output
improve(config): more helpful deprecation warnings
```

### Scopes

Scopes map to project layers and control version bump behavior.

#### Public layer (feat → minor)

User-facing changes: MCP tools, parameters, public interfaces.

| Scope       | Area                                  |
| ----------- | ------------------------------------- |
| `api`       | MCP facades, composition root         |
| `mcp`       | MCP protocol layer                    |
| `contracts` | Shared interfaces, registries         |
| `types`     | Type definitions                      |
| `drift`     | Payload schema drift detection        |

#### Functional layer (feat → minor)

Internal modules that affect search/indexing behavior.

| Scope        | Area                               |
| ------------ | ---------------------------------- |
| `search`     | Search orchestration               |
| `rerank`     | Reranking engine                   |
| `hybrid`     | Hybrid search (BM25+dense)        |
| `trajectory` | Trajectory implementations         |
| `signals`    | Signal system                      |
| `presets`    | Rerank presets                     |
| `filters`   | Qdrant filter descriptors         |
| `ingest`    | Indexing pipeline                  |
| `pipeline`  | Pipeline internals                 |
| `chunker`   | AST-aware code chunking           |

#### Infrastructure layer (feat → patch)

Internal adapters and utilities — not directly user-visible.

| Scope       | Area                                |
| ----------- | ----------------------------------- |
| `onnx`      | ONNX embedding provider             |
| `embedding` | Embedding providers (generic)       |
| `embedded`  | Embedded Qdrant                     |
| `adapters`  | External system adapters            |
| `qdrant`    | Qdrant client/types                 |
| `git`       | Git adapter                         |
| `config`    | Configuration system                |
| `factory`   | Factory wiring                      |
| `bootstrap` | App bootstrap                       |
| `debug`     | Debug utilities                     |
| `logs`      | Logging                             |

#### Non-release scopes (never triggers release)

| Scope      | Area                |
| ---------- | ------------------- |
| `test`     | Test infrastructure |
| `beads`    | Issue tracker       |
| `scripts`  | Utility scripts     |
| `ci`       | CI/CD               |
| `website`  | Documentation site  |
| `deps`     | Dependencies        |

### Version Bump Summary

| Commit                              | Bump    |
| ----------------------------------- | ------- |
| `feat(api): add new MCP tool`       | minor   |
| `feat(search): add new preset`      | minor   |
| `feat(onnx): add GPU detection`     | patch   |
| `improve(search): better errors`    | patch   |
| `fix(chunker): wrong line numbers`  | patch   |
| `refactor(trajectory): extract DI`  | patch   |
| `test(onnx): add daemon tests`      | none    |
| `chore: update dependencies`        | none    |
| Any type with `BREAKING CHANGE`     | major   |

### Breaking Changes

Add `BREAKING CHANGE:` footer when changes require user action:

```bash
feat(config): add embedded Qdrant support

BREAKING CHANGE: QDRANT_URL default changed from http://localhost:6333 to autodetect.
Users with Docker Qdrant should set QDRANT_URL=http://localhost:6333 explicitly.
```

Use `BREAKING CHANGE` for:
- Environment variable names, defaults, or semantics change
- Configuration file format or location changes
- CLI flags or arguments change
- Package name or data directory paths change

Do NOT use for:
- Internal refactoring without user-facing impact
- Additive features (no existing behavior changes)
- Bug fixes (unless buggy behavior was documented/relied upon)

### Commitlint Validation

Enforced rules:
- Conventional commits format required
- Valid type required (including `improve`)
- Subject must not be empty or end with period
- Subject must not start with uppercase
- Header max 100 characters

## Pull Request Process

1. Update docs if needed
2. Add tests for changes
3. Pass CI checks (build, type-check, tests)
4. Use conventional commit format for PR title
5. Request review

## Release Process

Automated via [semantic-release](https://semantic-release.gitbook.io/):

- Releases triggered on merge to `main`
- Version follows [Semantic Versioning](https://semver.org/)
- Changelog auto-generated from commits
- Package published to npm with provenance
- Documentation deployed to GitHub Pages

## Project Structure

```
tea-rags-mcp/
├── src/core/
│   ├── api/            # Composition root, MCP facades
│   ├── search/         # Query-time reranking engine
│   ├── trajectory/     # Provider implementations (static, git)
│   ├── ingest/         # Indexing pipeline, chunking, enrichment
│   ├── contracts/      # Shared interfaces, registries
│   └── adapters/       # External system types (Qdrant, git, embeddings)
├── tests/              # Test suite (mirrors src/ structure)
├── docs/               # Design docs and plans
├── website/            # Docusaurus documentation site
├── scripts/            # Utility scripts
└── .github/            # GitHub Actions workflows
```

## License

By contributing, you agree your contributions will be licensed under the MIT License.
