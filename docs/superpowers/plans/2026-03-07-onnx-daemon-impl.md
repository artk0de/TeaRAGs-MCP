# ONNX Embedding Daemon — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Replace in-process ONNX worker thread with a shared daemon process
that serves multiple MCP sessions via Unix socket.

**Architecture:** Daemon process owns the ONNX worker thread, listens on
`~/.tea-rags-mcp/onnx.sock`. `OnnxEmbeddings` is rewritten as a socket client.
First MCP session spawns daemon, subsequent sessions connect. Daemon shuts down
after idle timeout.

**Tech Stack:** Node.js `net.createServer`/`net.createConnection` (Unix socket),
NDJSON protocol, existing `worker.ts` unchanged.

---

### Task 1: Daemon Protocol Types

**Files:**

- Create: `src/core/adapters/embeddings/onnx/daemon-types.ts`
- Test: `tests/core/adapters/embeddings/onnx/daemon-types.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/adapters/embeddings/onnx/daemon-types.test.ts
import { describe, expect, it } from "vitest";

import {
  parseLine,
  serialize,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../../src/core/adapters/embeddings/onnx/daemon-types.js";

describe("daemon-types", () => {
  describe("serialize", () => {
    it("should append newline", () => {
      const msg: DaemonRequest = { type: "heartbeat" };
      expect(serialize(msg)).toBe('{"type":"heartbeat"}\n');
    });
  });

  describe("parseLine", () => {
    it("should parse valid JSON line", () => {
      const result = parseLine('{"type":"pong"}');
      expect(result).toEqual({ type: "pong" });
    });

    it("should return null for empty line", () => {
      expect(parseLine("")).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      expect(parseLine("{broken")).toBeNull();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon-types.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/core/adapters/embeddings/onnx/daemon-types.ts

/** Client → Daemon */
export type DaemonRequest =
  | { type: "connect"; model: string; device: string; cacheDir?: string }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "heartbeat" }
  | { type: "disconnect" }
  | { type: "status" }
  | { type: "shutdown" };

/** Daemon → Client */
export type DaemonResponse =
  | { type: "connected"; model: string; clients: number }
  | { type: "result"; id: number; embeddings: number[][] }
  | { type: "error"; message: string }
  | { type: "pong" }
  | {
      type: "status";
      model: string;
      device: string;
      clients: number;
      idleMs: number;
      uptime: number;
    }
  | { type: "bye" }
  | { type: "log"; level: "error"; message: string };

export function serialize(msg: DaemonRequest | DaemonResponse): string {
  return JSON.stringify(msg) + "\n";
}

export function parseLine(
  line: string,
): (DaemonRequest | DaemonResponse) | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx/daemon-types.ts tests/core/adapters/embeddings/onnx/daemon-types.test.ts
git commit -m "feat(onnx): add daemon protocol types and NDJSON serialization"
```

---

### Task 2: NDJSON Line Splitter

Incoming socket data may arrive as partial lines or multiple lines. Need a
stateful line splitter.

**Files:**

- Create: `src/core/adapters/embeddings/onnx/line-splitter.ts`
- Test: `tests/core/adapters/embeddings/onnx/line-splitter.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/adapters/embeddings/onnx/line-splitter.test.ts
import { describe, expect, it } from "vitest";

import { LineSplitter } from "../../../../src/core/adapters/embeddings/onnx/line-splitter.js";

describe("LineSplitter", () => {
  it("should emit complete lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"type":"pong"}\n');
    expect(lines).toEqual(['{"type":"pong"}']);
  });

  it("should buffer partial lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"type":');
    expect(lines).toEqual([]);

    splitter.feed('"pong"}\n');
    expect(lines).toEqual(['{"type":"pong"}']);
  });

  it("should handle multiple lines in one chunk", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("should skip empty lines", () => {
    const splitter = new LineSplitter();
    const lines: string[] = [];
    splitter.onLine((l) => lines.push(l));

    splitter.feed('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/line-splitter.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

```typescript
// src/core/adapters/embeddings/onnx/line-splitter.ts
export class LineSplitter {
  private buffer = "";
  private handler: ((line: string) => void) | null = null;

  onLine(handler: (line: string) => void): void {
    this.handler = handler;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop()!;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) this.handler?.(trimmed);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/line-splitter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx/line-splitter.ts tests/core/adapters/embeddings/onnx/line-splitter.test.ts
git commit -m "feat(onnx): add NDJSON line splitter for socket communication"
```

---

### Task 3: Daemon Server

**Files:**

- Create: `src/core/adapters/embeddings/onnx/daemon.ts`
- Test: `tests/core/adapters/embeddings/onnx/daemon.test.ts`

**Step 1: Write the failing test**

Test daemon lifecycle: start → client connects → embed → client disconnects →
idle shutdown. Mock the worker thread (same approach as existing
`onnx.test.ts`).

```typescript
// tests/core/adapters/embeddings/onnx/daemon.test.ts
import { existsSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseLine,
  serialize,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../../src/core/adapters/embeddings/onnx/daemon-types.js";
// Import daemon after we know the types exist
import { OnnxDaemon } from "../../../../src/core/adapters/embeddings/onnx/daemon.js";

function randomSocket(): string {
  return join(
    tmpdir(),
    `onnx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function connectAndSend(
  socketPath: string,
  msg: DaemonRequest,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(serialize(msg));
    });
    let buf = "";
    client.on("data", (data) => {
      buf += data.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        const parsed = parseLine(line);
        if (parsed) {
          resolve(parsed as DaemonResponse);
          client.end();
          return;
        }
      }
    });
    client.on("error", reject);
  });
}

describe("OnnxDaemon", () => {
  let daemon: OnnxDaemon;
  let socketPath: string;

  beforeEach(() => {
    socketPath = randomSocket();
  });

  afterEach(async () => {
    await daemon?.stop();
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  it("should start and accept status request", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 5000,
      heartbeatTimeoutMs: 45000,
    });
    await daemon.start();

    const response = await connectAndSend(socketPath, { type: "status" });
    expect(response.type).toBe("status");
    expect((response as DaemonResponse & { type: "status" }).clients).toBe(0);
  });

  it("should accept connect and track clients", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 5000,
      heartbeatTimeoutMs: 45000,
    });
    await daemon.start();

    const response = await connectAndSend(socketPath, {
      type: "connect",
      model: "test-model",
      device: "cpu",
    });
    expect(response.type).toBe("connected");
  });

  it("should shutdown on request", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 5000,
      heartbeatTimeoutMs: 45000,
    });
    await daemon.start();

    const response = await connectAndSend(socketPath, { type: "shutdown" });
    expect(response.type).toBe("bye");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon.test.ts`
Expected: FAIL — `OnnxDaemon` not found

**Step 3: Write implementation**

`daemon.ts` — Unix socket server that:

- Creates `net.Server` on `socketPath`
- On client connect: sets up LineSplitter, handles messages
- `connect` message: loads worker if first client, validates model, increments
  refcount
- `embed` message: forwards to worker, returns result
- `heartbeat` message: responds with pong, resets client timer
- `disconnect` message: decrements refcount, starts idle timer if 0
- `status` message: returns current state
- `shutdown` message: responds bye, stops server
- Client socket close without disconnect: decrement refcount
- Heartbeat timeout (45s): treat as dead client
- Idle timeout (30s after last client): stop daemon

Full implementation — approximately 200 lines. Key structure:

```typescript
// src/core/adapters/embeddings/onnx/daemon.ts
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  parseLine,
  serialize,
  type DaemonRequest,
  type DaemonResponse,
} from "./daemon-types.js";
import { LineSplitter } from "./line-splitter.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

export interface DaemonConfig {
  socketPath: string;
  pidFile?: string;
  idleTimeoutMs: number;
  heartbeatTimeoutMs: number;
}

interface ClientState {
  socket: Socket;
  connected: boolean; // sent connect message
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

export class OnnxDaemon {
  // Server, worker, client tracking, idle timer, model state
  // Methods: start(), stop(), handleMessage(), loadWorker(), etc.
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx/daemon.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx/daemon.ts tests/core/adapters/embeddings/onnx/daemon.test.ts
git commit -m "feat(onnx): implement daemon server with Unix socket and lifecycle management"
```

---

### Task 4: Daemon Embed Integration Test

**Files:**

- Modify: `tests/core/adapters/embeddings/onnx/daemon.test.ts`

Test that daemon actually forwards embed requests to worker and returns results.
This requires the real worker.ts (not mocked) but with a mock model.

**Step 1: Add embed test to daemon.test.ts**

```typescript
it("should forward embed request to worker and return result", async () => {
  // This test uses a mock worker that returns fixed embeddings.
  // The daemon's constructor accepts an optional workerFactory for testing.
  const mockWorkerFactory = () => {
    /* return mock worker */
  };
  daemon = new OnnxDaemon({
    socketPath,
    idleTimeoutMs: 5000,
    heartbeatTimeoutMs: 45000,
    workerFactory: mockWorkerFactory,
  });
  await daemon.start();

  // Connect
  const client = createConnection(socketPath);
  await sendAndExpect(
    client,
    { type: "connect", model: "m", device: "cpu" },
    "connected",
  );

  // Embed
  const response = await sendAndExpect(
    client,
    { type: "embed", id: 1, texts: ["hello"] },
    "result",
  );
  expect(response.embeddings).toBeDefined();
  expect(response.embeddings[0]).toHaveLength(768);

  client.end();
});
```

**Step 2–5:** Implement helper, verify pass, commit.

```bash
git commit -m "test(onnx): add daemon embed integration test"
```

---

### Task 5: Rewrite OnnxEmbeddings as Socket Client

**Files:**

- Rewrite: `src/core/adapters/embeddings/onnx.ts`
- Rewrite: `tests/core/adapters/embeddings/onnx.test.ts`

**Step 1: Write the failing test**

New tests mock `net.createConnection` and `child_process.spawn` instead of
`worker_threads`.

```typescript
// Key test cases:
// 1. ensureInitialized: spawns daemon if socket missing, connects, sends connect
// 2. embed: sends embed request, returns result
// 3. embedBatch: sends embed request with multiple texts
// 4. heartbeat: setInterval sends heartbeat every 30s
// 5. terminate: sends disconnect, clears heartbeat
// 6. reconnect: if socket errors, respawns daemon and retries
// 7. model mismatch: daemon returns error → throw
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: FAIL

**Step 3: Rewrite OnnxEmbeddings**

```typescript
// src/core/adapters/embeddings/onnx.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EmbeddingProvider, EmbeddingResult } from "./base.js";
import {
  parseLine,
  serialize,
  type DaemonRequest,
  type DaemonResponse,
} from "./onnx/daemon-types.js";
import { LineSplitter } from "./onnx/line-splitter.js";

export class OnnxEmbeddings implements EmbeddingProvider {
  private socket: Socket | null = null;
  private splitter: LineSplitter | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<number, { resolve; reject }>();
  private nextId = 0;
  private initPromise: Promise<void> | null = null;

  // ensureInitialized: check socket → spawn daemon → connect → send connect
  // embed/embedBatch: send embed via socket, wait for result by id
  // terminate: send disconnect, cleanup
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/adapters/embeddings/onnx.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/adapters/embeddings/onnx.ts tests/core/adapters/embeddings/onnx.test.ts
git commit -m "feat(onnx): rewrite OnnxEmbeddings as daemon socket client"
```

---

### Task 6: Daemon Spawn Logic

**Files:**

- Modify: `src/core/adapters/embeddings/onnx.ts` (add `spawnDaemon` method)
- Modify: `src/core/adapters/embeddings/onnx/daemon.ts` (add CLI entry point)

The daemon needs a CLI entry point so it can be spawned as a detached process.

**Step 1: Add entry point to daemon.ts**

```typescript
// At bottom of daemon.ts — only runs when executed directly
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*build\//, ""))
) {
  const socketPath = process.argv[2];
  const pidFile = process.argv[3];
  if (!socketPath) {
    console.error("Usage: daemon.js <socketPath> [pidFile]");
    process.exit(1);
  }
  const daemon = new OnnxDaemon({
    socketPath,
    pidFile,
    idleTimeoutMs: 30_000,
    heartbeatTimeoutMs: 45_000,
  });
  await daemon.start();
}
```

**Step 2: Add spawnDaemon to OnnxEmbeddings**

```typescript
private async spawnDaemon(): Promise<void> {
  const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "onnx", "daemon.js");
  const child = spawn(process.execPath, [daemonPath, this.socketPath, this.pidFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll for socket to appear (max 30s)
  await this.waitForSocket(30_000);
}
```

**Step 3: Test spawn + connect flow (integration)**

**Step 4: Commit**

```bash
git commit -m "feat(onnx): add daemon CLI entry point and spawn logic"
```

---

### Task 7: Paths Helper

**Files:**

- Modify: `src/bootstrap/config/paths.ts` — add `daemonSocketPath()` and
  `daemonPidFile()`

**Step 1: Write test**

```typescript
it("should return socket path in app data dir", () => {
  expect(daemonSocketPath()).toMatch(/\.tea-rags-mcp\/onnx\.sock$/);
});
```

**Step 2: Implement**

```typescript
export function daemonSocketPath(): string {
  return join(appDataDir(), "onnx.sock");
}

export function daemonPidFile(): string {
  return join(appDataDir(), "onnx-daemon.pid");
}
```

**Step 3: Commit**

```bash
git commit -m "feat(config): add daemon socket and PID file paths"
```

---

### Task 8: Factory Integration

**Files:**

- Modify: `src/core/adapters/embeddings/factory.ts` — pass socketPath/pidFile to
  OnnxEmbeddings
- Modify: `tests/core/adapters/embeddings/factory.test.ts`

**Step 1: Update factory to pass socket paths**

```typescript
case "onnx":
  return new OnnxEmbeddings(
    model || DEFAULT_ONNX_MODEL,
    dimensions,
    modelsDir(),
    config.device,
    daemonSocketPath(),
    daemonPidFile(),
  );
```

**Step 2: Update factory test, commit**

```bash
git commit -m "feat(factory): wire daemon socket paths into OnnxEmbeddings"
```

---

### Task 9: End-to-End Integration Test

**Files:**

- Create: `tests/core/adapters/embeddings/onnx/e2e-daemon.test.ts`

Manual test script (not vitest) that:

1. Starts daemon
2. Connects two clients
3. Both send embed requests
4. Verifies sequential processing (no GPU contention)
5. Client 1 disconnects
6. Client 2 still works
7. Client 2 disconnects
8. Daemon auto-shuts down after idle timeout

```bash
git commit -m "test(onnx): add daemon end-to-end integration test"
```

---

### Task 10: Cleanup and Documentation

**Files:**

- Remove diagnostic code from `worker.ts` (sequential lock stays, temp logging
  removed)
- Update `CLAUDE.md` if needed
- Verify `npx vitest run` passes all tests

```bash
git commit -m "chore(onnx): cleanup diagnostic code, finalize daemon implementation"
```
