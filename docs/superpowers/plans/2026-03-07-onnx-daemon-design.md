# ONNX Embedding Daemon — Shared Inference Server

Issue: `tea-rags-mcp-gdj`

## Problem

Each MCP session spawns its own ONNX worker thread, loading a 321MB model into
GPU memory. Multiple Claude Code sessions = multiple models competing for Metal
GPU. Model warmup (WebGPU shader compilation) takes 9-14s on first two batches
every time.

## Solution

A single daemon process manages the ONNX worker thread. MCP sessions connect as
clients via Unix socket.

```
MCP Session 1 --+
MCP Session 2 --+-- Unix socket -- ONNX Daemon -- Worker Thread -- GPU
MCP Session N --+    (NDJSON)      (node)          (sequential)
                 ~/.tea-rags-mcp/onnx.sock
```

## Decisions

| Decision       | Choice                    | Rationale                                                                                   |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| IPC            | Unix socket               | No port conflicts, fast, auto-cleanup on crash. Windows out of scope (WebGPU Metal target). |
| Protocol       | NDJSON                    | Simple, low overhead. Bottleneck is inference, not serialization.                           |
| API surface    | embed + status + shutdown | Status for diagnostics, shutdown for graceful cleanup.                                      |
| Model conflict | First client wins         | Error if subsequent client requests different model. Covers 99% case.                       |
| Lifecycle      | Refcount + heartbeat      | Heartbeat 30s detects crashed clients. Idle 30s after last disconnect.                      |
| Integration    | Replace OnnxEmbeddings    | Single code path, no legacy fallback.                                                       |

## Protocol (NDJSON over Unix socket)

### connect (required first message)

```json
-> {"type":"connect","model":"jinaai/jina-embeddings-v2-base-code-fp16","device":"webgpu","cacheDir":"~/.tea-rags-mcp/models"}
<- {"type":"connected","model":"jinaai/jina-embeddings-v2-base-code-fp16","clients":2}
```

If model mismatch:

```json
<- {"type":"error","message":"daemon running with different model: jinaai/jina-embeddings-v2-base-code-fp16"}
```

### embed

```json
-> {"type":"embed","id":1,"texts":["function hello()..."]}
<- {"type":"result","id":1,"embeddings":[[0.044,...]]}
```

### heartbeat (client sends every 30s)

```json
-> {"type":"heartbeat"}
<- {"type":"pong"}
```

### disconnect

```json
-> {"type":"disconnect"}
```

No response. Daemon decrements refcount.

### status

```json
-> {"type":"status"}
<- {"type":"status","model":"...","device":"webgpu","clients":2,"idleMs":0,"uptime":3600}
```

### shutdown

```json
-> {"type":"shutdown"}
<- {"type":"bye"}
```

## Components

### Daemon (`src/core/adapters/embeddings/onnx/daemon.ts`)

- Standalone node process, spawned detached (`child_process.spawn` with
  `detached: true, stdio: 'ignore'`)
- Listens on `~/.tea-rags-mcp/onnx.sock`
- Reuses existing `worker.ts` for inference (unchanged)
- Sequential lock on GPU inference (already in worker.ts)
- Tracks connected clients with heartbeat timeout (45s without heartbeat = dead
  client)
- Writes PID to `~/.tea-rags-mcp/onnx-daemon.pid`
- Shuts down 30s after last client disconnects

### OnnxEmbeddings (`src/core/adapters/embeddings/onnx.ts` — rewritten)

- `ensureInitialized()`:
  1. Check if socket exists and daemon responds
  2. If not: spawn daemon, wait for socket to appear (poll with timeout)
  3. Connect, send `connect` message, verify model match
- `embed()` / `embedBatch()`: send `embed` via socket, await `result`
- Heartbeat: setInterval 30s while connected
- `terminate()`: send `disconnect`, close socket, clear heartbeat
- Reconnect on socket error (daemon crashed): respawn + retry once

### Unchanged

- `worker.ts` — moves into daemon, no code changes
- `worker-types.ts` — internal to daemon
- `device.ts` — internal to daemon
- `factory.ts` — still creates `OnnxEmbeddings`, no changes
- `base.ts` — `EmbeddingProvider` interface unchanged

## Files

| File                                          | Action                 |
| --------------------------------------------- | ---------------------- |
| `src/core/adapters/embeddings/onnx/daemon.ts` | New: daemon server     |
| `src/core/adapters/embeddings/onnx.ts`        | Rewrite: socket client |
| `src/core/adapters/embeddings/onnx/worker.ts` | Unchanged              |
| `~/.tea-rags-mcp/onnx.sock`                   | Runtime: Unix socket   |
| `~/.tea-rags-mcp/onnx-daemon.pid`             | Runtime: PID file      |

## Out of Scope

- Multi-model support (see `tea-rags-mcp-4mu`)
- HTTP fallback for Windows
- Separate config file
- Legacy in-process fallback
