/**
 * ONNX Embedding Daemon Server.
 *
 * Listens on a Unix socket, manages a single ONNX worker thread,
 * accepts multiple client connections via NDJSON protocol,
 * tracks clients with heartbeat, and shuts down after idle timeout.
 */

import { createServer, type Server, type Socket } from "node:net";
import { Worker } from "node:worker_threads";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";

import { LineSplitter } from "./line-splitter.js";
import { serialize, parseLine, type DaemonRequest, type DaemonResponse } from "./daemon-types.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";
import { DEFAULT_GPU_BATCH_SIZE } from "./constants.js";
import { BatchSizeController } from "./batch-size-controller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  socketPath: string;
  pidFile?: string;
  idleTimeoutMs: number;
  heartbeatTimeoutMs: number;
  /** Injectable worker factory for testing */
  workerFactory?: () => WorkerLike;
}

/** Minimal worker interface matching what we need from Worker / mock */
interface WorkerLike extends EventEmitter {
  postMessage: (msg: WorkerRequest) => void;
  terminate: () => Promise<number>;
}

interface ClientState {
  socket: Socket;
  connected: boolean; // has sent "connect" message
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// OnnxDaemon
// ---------------------------------------------------------------------------

export class OnnxDaemon {
  private server: Server | null = null;
  private worker: WorkerLike | null = null;
  private readonly clients = new Map<Socket, ClientState>();
  private readonly config: DaemonConfig;

  // Model state
  private loadedModel = "";
  private loadedDevice = "";
  private workerReady = false;
  private workerReadyPromise: Promise<void> | null = null;
  private workerReadyResolve: (() => void) | null = null;

  // Pending embed callbacks: id → (response) => void
  private readonly pendingEmbeds = new Map<number, (resp: WorkerResponse) => void>();

  // Idle timer
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime = 0;
  private lastActivityTime = 0;

  // Adaptive batch size
  private batchController: BatchSizeController | null = null;
  private calibratedBatchSize: number | undefined;

  // Shutdown tracking
  private stopped = false;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.lastActivityTime = Date.now();
    this.stopped = false;

    // Clean up stale socket file
    if (existsSync(this.config.socketPath)) {
      unlinkSync(this.config.socketPath);
    }

    this.server = createServer((socket) => { this.handleConnection(socket); });

    const { server } = this;
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(this.config.socketPath, () => { resolve(); });
    });

    // Write PID file
    if (this.config.pidFile) {
      writeFileSync(this.config.pidFile, String(process.pid), "utf-8");
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.clearIdleTimer();

    // Clear all client heartbeat timers
    for (const [socket, state] of this.clients) {
      this.clearHeartbeatTimer(state);
      socket.destroy();
    }
    this.clients.clear();

    // Terminate worker
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // ignore
      }
      this.worker = null;
      this.workerReady = false;
      this.loadedModel = "";
      this.loadedDevice = "";
    }

    // Close server
    if (this.server) {
      const { server: srv } = this;
      await new Promise<void>((resolve) => {
        srv.close(() => { resolve(); });
      });
      this.server = null;
    }

    // Clean up files
    this.cleanupFiles();
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const state: ClientState = {
      socket,
      connected: false,
      heartbeatTimer: null,
    };

    this.clients.set(socket, state);
    const splitter = new LineSplitter();

    splitter.onLine((line) => {
      const msg = parseLine(line);
      if (msg) {
        void this.handleMessage(socket, state, msg as DaemonRequest);
      }
    });

    socket.on("data", (data) => { splitter.feed(data.toString()); });

    socket.on("close", () => {
      this.handleClientDisconnect(socket, state);
    });

    /* v8 ignore next 3 -- error always precedes close; close handler covers this path */
    socket.on("error", () => {
      this.handleClientDisconnect(socket, state);
    });
  }

  private handleClientDisconnect(socket: Socket, state: ClientState): void {
    if (!this.clients.has(socket)) return; // already cleaned up

    this.clearHeartbeatTimer(state);
    const wasConnected = state.connected;
    state.connected = false;
    this.clients.delete(socket);

    if (wasConnected) {
      this.onClientCountChanged();
    }
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async handleMessage(socket: Socket, state: ClientState, msg: DaemonRequest): Promise<void> {
    this.lastActivityTime = Date.now();

    switch (msg.type) {
      case "connect":
        await this.handleConnect(socket, state, msg.model, msg.device, msg.cacheDir);
        break;

      case "embed":
        await this.handleEmbed(socket, state, msg.id, msg.texts);
        break;

      case "heartbeat":
        this.resetHeartbeatTimer(state);
        this.send(socket, { type: "pong" });
        break;

      case "disconnect":
        this.send(socket, { type: "bye" });
        this.handleClientDisconnect(socket, state);
        break;

      case "status":
        this.send(socket, {
          type: "status",
          model: this.loadedModel,
          device: this.loadedDevice,
          clients: this.connectedClientCount(),
          idleMs: this.connectedClientCount() === 0 ? Date.now() - this.lastActivityTime : 0,
          uptime: Date.now() - this.startTime,
        });
        break;

      case "shutdown":
        this.send(socket, { type: "bye" });
        // Stop daemon asynchronously
        setImmediate(() => void this.stop());
        break;
    }
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  private async handleConnect(
    socket: Socket,
    state: ClientState,
    model: string,
    device: string,
    cacheDir?: string,
  ): Promise<void> {
    // If a model is already loaded, reject mismatched model
    if (this.loadedModel && this.loadedModel !== model) {
      this.send(socket, {
        type: "error",
        message: `Model mismatch: daemon has "${this.loadedModel}" loaded, requested "${model}"`,
      });
      return;
    }

    // Spawn worker if not yet created
    if (!this.worker) {
      const worker = this.spawnWorker();
      this.loadedModel = model;
      this.loadedDevice = device;

      // Create ready promise
      this.workerReadyPromise = new Promise<void>((resolve) => {
        this.workerReadyResolve = resolve;
      });

      // Send init to worker
      worker.postMessage({ type: "init", model, cacheDir, device });
    }

    // Wait for worker to be ready
    if (!this.workerReady && this.workerReadyPromise) {
      await this.workerReadyPromise;
    }

    state.connected = true;
    this.clearIdleTimer(); // cancel idle shutdown if pending
    this.resetHeartbeatTimer(state);

    this.send(socket, {
      type: "connected",
      model: this.loadedModel,
      clients: this.connectedClientCount(),
      recommendedBatchSize: this.batchController?.recommendedPipelineBatchSize(),
    });
  }

  // -------------------------------------------------------------------------
  // embed
  // -------------------------------------------------------------------------

  /** Send embed request to worker and wait for response */
  private async embedViaWorker(
    worker: WorkerLike,
    id: number,
    texts: string[],
  ): Promise<WorkerResponse> {
    return new Promise<WorkerResponse>((resolve) => {
      this.pendingEmbeds.set(id, resolve);
      worker.postMessage({ type: "embed", id, texts });
    });
  }

  private async handleEmbed(socket: Socket, state: ClientState, id: number, texts: string[]): Promise<void> {
    const { worker } = this;
    if (!state.connected || !worker || !this.workerReady) {
      this.send(socket, { type: "error", message: "Client not connected. Send 'connect' first." });
      return;
    }

    const batchSize = this.batchController?.currentBatchSize() ?? DEFAULT_GPU_BATCH_SIZE;

    // Fast path: single batch fits in GPU limit
    if (texts.length <= batchSize) {
      const resp = await this.embedViaWorker(worker, id, texts);
      if (resp.type === "result") {
        this.batchController?.report(resp.durationMs, texts.length);
        this.send(socket, { type: "result", id, embeddings: resp.embeddings });
      } else if (resp.type === "error") {
        this.send(socket, { type: "error", message: resp.message });
      }
      return;
    }

    // Split into sub-batches
    const allEmbeddings: number[][] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      const subTexts = texts.slice(offset, offset + batchSize);
      const subId = id * 10000 + offset; // unique sub-id to avoid collision with pending map
      const resp = await this.embedViaWorker(worker, subId, subTexts);

      if (resp.type === "error") {
        this.send(socket, { type: "error", message: resp.message });
        return;
      }
      if (resp.type === "result") {
        this.batchController?.report(resp.durationMs, subTexts.length);
        allEmbeddings.push(...resp.embeddings);
      }
    }

    this.send(socket, { type: "result", id, embeddings: allEmbeddings });
  }

  // -------------------------------------------------------------------------
  // Worker management
  // -------------------------------------------------------------------------

  private spawnWorker(): WorkerLike {
    if (this.config.workerFactory) {
      this.worker = this.config.workerFactory();
    } else {
      /* v8 ignore next 2 -- real Worker path, tested via e2e */
      const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
      this.worker = new Worker(workerPath) as unknown as WorkerLike;
    }

    const { worker } = this;
    worker.on("message", (msg: WorkerResponse) => {
      this.handleWorkerMessage(msg);
    });

    worker.on("error", (err: Error) => {
      console.error(`[OnnxDaemon] Worker error: ${err.message}`);
    });

    worker.on("exit", (_code: number) => {
      this.worker = null;
      this.workerReady = false;
    });

    return worker;
  }

  private handleWorkerMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case "ready":
        this.workerReady = true;
        if (this.workerReadyResolve) {
          this.workerReadyResolve();
          this.workerReadyResolve = null;
          this.workerReadyPromise = null;
        }
        break;

      case "calibrated": {
        this.calibratedBatchSize = msg.batchSize;
        this.batchController = new BatchSizeController(msg.batchSize);
        console.error(`[OnnxDaemon] Calibrated GPU batch size: ${msg.batchSize}, recommended pipeline: ${this.batchController.recommendedPipelineBatchSize()}`);
        break;
      }

      case "result":
      case "error": {
        const callback = this.pendingEmbeds.get(msg.id);
        if (callback) {
          this.pendingEmbeds.delete(msg.id);
          callback(msg);
        }
        break;
      }

      case "log":
        // Forward log to all connected clients
        for (const [sock, state] of this.clients) {
          if (state.connected) {
            this.send(sock, { type: "log", level: msg.level, message: msg.message });
          }
        }
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private resetHeartbeatTimer(state: ClientState): void {
    this.clearHeartbeatTimer(state);
    state.heartbeatTimer = setTimeout(() => {
      // Client considered dead
      this.handleClientDisconnect(state.socket, state);
      state.socket.destroy();
    }, this.config.heartbeatTimeoutMs);
  }

  private clearHeartbeatTimer(state: ClientState): void {
    if (state.heartbeatTimer) {
      clearTimeout(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  private onClientCountChanged(): void {
    if (this.connectedClientCount() === 0 && this.worker) {
      this.startIdleTimer();
    }
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private connectedClientCount(): number {
    let count = 0;
    for (const [, state] of this.clients) {
      if (state.connected) count++;
    }
    return count;
  }

  private send(socket: Socket, msg: DaemonResponse): void {
    if (!socket.destroyed) {
      socket.write(serialize(msg));
    }
  }

  private cleanupFiles(): void {
    try {
      if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
    } catch {
      // ignore
    }
    try {
      if (this.config.pidFile && existsSync(this.config.pidFile)) unlinkSync(this.config.pidFile);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry — runs when executed as: node daemon.js <socketPath> [pidFile]
// ---------------------------------------------------------------------------

/* v8 ignore start */
const isDirectRun =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].replace(/.*build\//, "")));

if (isDirectRun) {
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

  const shutdown = () => void daemon.stop().then(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await daemon.start();
  console.error(`[OnnxDaemon] Listening on ${socketPath} (PID ${process.pid})`);
}
/* v8 ignore stop */
