# Design: Embedded Qdrant

**Date:** 2026-03-09 **Status:** Approved

## Problem

tea-rags requires a running Qdrant instance via Docker/Podman. This adds
friction for users — they need to install Docker, run `compose up`, and manage a
separate service. For an MCP server, the ideal experience is zero-config:
`npm install` and it works.

## Solution

Bundle Qdrant as a managed child process. Download the official binary at
install time (postinstall), spawn it automatically when the MCP server starts.

## Connection Mode

Single env var `QDRANT_URL` controls behavior:

| Value             | Behavior                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| not set (default) | **Autodetect**: probe `http://localhost:6333/readyz`. If responds — use external. If not — start embedded. |
| `embedded`        | Always start embedded Qdrant child process                                                                 |
| `http://...`      | Always connect to external Qdrant. Error if unreachable.                                                   |

## Binary Lifecycle

### Download (postinstall)

`postinstall` script in package.json:

1. Detect `process.platform` + `process.arch`
2. Map to Qdrant release asset name:
   - `darwin` + `arm64` → `qdrant-aarch64-apple-darwin.tar.gz`
   - `darwin` + `x64` → `qdrant-x86_64-apple-darwin.tar.gz`
   - `linux` + `x64` → `qdrant-x86_64-unknown-linux-gnu.tar.gz`
   - `linux` + `arm64` → `qdrant-aarch64-unknown-linux-musl.tar.gz`
3. Download from
   `https://github.com/qdrant/qdrant/releases/download/v{VERSION}/...`
4. Extract to `node_modules/.cache/tea-rags/qdrant`
5. On failure — warn, don't error. Binary will be downloaded lazily at first
   startup.

### Lazy Fallback

If binary not found at startup → download it then. Same logic as postinstall.
Provides resilience against postinstall failures (CI caches, network issues
during install).

### Pinned Version

Qdrant version is pinned in source (e.g., `QDRANT_VERSION = "1.17.0"`). Updated
manually when compatibility is verified.

## Managed Process

On MCP server startup (when embedded mode is active):

1. Find a free port (not hardcoded 6333 — avoid conflicts)
2. Spawn `qdrant` binary with:
   - `--storage-path {QDRANT_EMBEDDED_STORAGE_PATH}`
   - Port configuration via config file or env vars
3. Wait for `/readyz` health check (with timeout)
4. Create `QdrantManager` pointing to `http://localhost:{port}`
5. On MCP server shutdown: SIGTERM → wait → SIGKILL

## Storage

- Default path: `~/.tea-rags/qdrant/`
- Override: `QDRANT_EMBEDDED_STORAGE_PATH` env var
- Uses native Qdrant storage format (compatible with external Qdrant)

## Package Rename

As part of this change, rename npm package:

- `tea-rags-mcp` → `tea-rags`
- Update package.json `name` field
- Update CI publish workflow
- Update documentation references

## Migration

**Autodetect ensures backward compatibility:**

- Users with Docker Qdrant running → autodetect finds it, uses external (no
  change)
- Users without Docker → autodetect starts embedded (improved DX)
- Users with explicit `QDRANT_URL` → behavior unchanged

No breaking changes for existing users.

## What Does NOT Change

- `QdrantManager` and `@qdrant/js-client-rest` — remain as-is
- All MCP tools API — unchanged
- Qdrant storage format — native, same as Docker version
- Hybrid search, sparse vectors, payload indexes — all supported (same Qdrant)

## New Env Vars

| Var                            | Default               | Description                                       |
| ------------------------------ | --------------------- | ------------------------------------------------- |
| `QDRANT_URL`                   | (autodetect)          | `embedded`, `http://...`, or unset for autodetect |
| `QDRANT_EMBEDDED_STORAGE_PATH` | `~/.tea-rags/qdrant/` | Data directory for embedded mode                  |

## Supported Platforms

| Platform | Arch  | Binary                                             |
| -------- | ----- | -------------------------------------------------- |
| macOS    | arm64 | `qdrant-aarch64-apple-darwin.tar.gz` (~25MB)       |
| macOS    | x64   | `qdrant-x86_64-apple-darwin.tar.gz` (~27MB)        |
| Linux    | x64   | `qdrant-x86_64-unknown-linux-gnu.tar.gz` (~28MB)   |
| Linux    | arm64 | `qdrant-aarch64-unknown-linux-musl.tar.gz` (~26MB) |

## Risks

- **Binary size**: ~25-28MB added to install. Acceptable for a development tool.
- **GitHub rate limits**: postinstall downloads from GitHub releases. Lazy
  fallback mitigates.
- **Qdrant version upgrades**: manual process, needs compatibility testing.
- **Port conflicts**: mitigated by dynamic port selection.
