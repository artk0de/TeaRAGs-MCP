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
import { EventEmitter } from "node:events";

import { LineSplitter } from "./line-splitter.js";
import { serialize, parseLine, type DaemonRequest, type DaemonResponse } from "./daemon-types.js";
import type { WorkerRequest, WorkerResponse } from "./worker-types.js";

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
  postMessage(msg: WorkerRequest): void;
  terminate(): Promise<number>;
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

    this.server = createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.config.socketPath, () => resolve());
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
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
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

    socket.on("data", (data) => splitter.feed(data.toString()));

    socket.on("close", () => {
      this.handleClientDisconnect(socket, state);
    });

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
      this.spawnWorker();
      this.loadedModel = model;
      this.loadedDevice = device;

      // Create ready promise
      this.workerReadyPromise = new Promise<void>((resolve) => {
        this.workerReadyResolve = resolve;
      });

      // Send init to worker
      this.worker!.postMessage({ type: "init", model, cacheDir, device });
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
    });
  }

  // -------------------------------------------------------------------------
  // embed
  // -------------------------------------------------------------------------

  private async handleEmbed(socket: Socket, state: ClientState, id: number, texts: string[]): Promise<void> {
    if (!state.connected || !this.worker || !this.workerReady) {
      this.send(socket, { type: "error", message: "Client not connected. Send 'connect' first." });
      return;
    }

    // Forward to worker and wait for response
    const resp = await new Promise<WorkerResponse>((resolve) => {
      this.pendingEmbeds.set(id, resolve);
      this.worker!.postMessage({ type: "embed", id, texts });
    });

    if (resp.type === "result") {
      this.send(socket, { type: "result", id: resp.id, embeddings: resp.embeddings });
    } else if (resp.type === "error") {
      this.send(socket, { type: "error", message: resp.message });
    }
  }

  // -------------------------------------------------------------------------
  // Worker management
  // -------------------------------------------------------------------------

  private spawnWorker(): void {
    if (this.config.workerFactory) {
      this.worker = this.config.workerFactory() as WorkerLike;
    } else {
      const workerPath = join(dirname(fileURLToPath(import.meta.url)), "worker.js");
      this.worker = new Worker(workerPath) as unknown as WorkerLike;
    }

    this.worker.on("message", (msg: WorkerResponse) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on("error", (err: Error) => {
      console.error(`[OnnxDaemon] Worker error: ${err.message}`);
    });

    this.worker.on("exit", (_code: number) => {
      this.worker = null;
      this.workerReady = false;
    });
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
