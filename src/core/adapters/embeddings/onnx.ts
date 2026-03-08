import { createConnection, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { EmbeddingProvider, EmbeddingResult } from "./base.js";
import { getModelDimensions } from "./utils/model-dimensions.js";
import { LineSplitter } from "./onnx/line-splitter.js";
import {
  serialize,
  parseLine,
  type DaemonRequest,
  type DaemonResponse,
} from "./onnx/daemon-types.js";

export const DEFAULT_ONNX_MODEL = "jinaai/jina-embeddings-v2-base-code-fp16";
export const DEFAULT_ONNX_DIMENSIONS = 768;

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_SOCKET_PATH = "/tmp/onnx-embedding-daemon.sock";

export class OnnxEmbeddings implements EmbeddingProvider {
  private readonly model: string;
  private readonly dimensions: number;
  private readonly cacheDir: string | undefined;
  private readonly device: string;
  private readonly socketPath: string;
  private readonly pidFile: string | undefined;

  private socket: Socket | null = null;
  private splitter: LineSplitter | null = null;
  private connectPromise: Promise<void> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private nextId = 0;

  public recommendedBatchSize?: number;

  // Pending embed requests: id → { resolve, reject }
  private readonly pending = new Map<
    number,
    { resolve: (embeddings: number[][]) => void; reject: (err: Error) => void }
  >();

  /** Max time (ms) to wait for daemon socket to appear after spawn. @internal */
  private readonly spawnTimeoutMs: number;

  constructor(
    model = DEFAULT_ONNX_MODEL,
    dimensions?: number,
    cacheDir?: string,
    device = "cpu",
    socketPath = DEFAULT_SOCKET_PATH,
    pidFile?: string,
    spawnTimeoutMs = 30_000,
  ) {
    this.model = model;
    this.dimensions = dimensions || getModelDimensions(model) || DEFAULT_ONNX_DIMENSIONS;
    this.cacheDir = cacheDir;
    this.device = device;
    this.socketPath = socketPath;
    this.pidFile = pidFile;
    this.spawnTimeoutMs = spawnTimeoutMs;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    // Spawn daemon if socket does not exist yet
    if (!existsSync(this.socketPath)) {
      await this.spawnDaemon();
    }

    this.connectPromise = this.connectToDaemon();

    try {
      await this.connectPromise;
    } catch (err) {
      this.connectPromise = null;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Daemon spawn
  // ---------------------------------------------------------------------------

  private async spawnDaemon(): Promise<void> {
    const daemonPath = join(dirname(fileURLToPath(import.meta.url)), "onnx", "daemon.js");

    const child: ChildProcess = spawn(
      process.execPath,
      [daemonPath, this.socketPath, this.pidFile ?? ""],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    // Poll for socket file to appear
    const maxWaitMs = this.spawnTimeoutMs;
    const pollMs = 100;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      /* v8 ignore next -- success path tested via e2e (real daemon spawn) */
      if (existsSync(this.socketPath)) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }

    throw new Error(
      `Timed out waiting for ONNX daemon to start (socket: ${this.socketPath})`,
    );
  }

  private async connectToDaemon(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const splitter = new LineSplitter();

      // Timeout for connect handshake
      /* v8 ignore start */
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timeout connecting to ONNX daemon at ${this.socketPath}`));
      }, 10_000);
      /* v8 ignore stop */

      socket.on("error", (err) => {
        clearTimeout(timeout);
        if (!handshakeDone) {
          handshakeDone = true;
          reject(new Error(`Cannot connect to ONNX daemon at ${this.socketPath}: ${err.message}`));
        } else {
          /* v8 ignore start */
          this.cleanup();
          this.rejectAllPending(new Error(`Socket error: ${err.message}`));
          /* v8 ignore stop */
        }
      });

      socket.on("close", () => {
        this.cleanup();
        // Reject any pending requests
        this.rejectAllPending(new Error("Socket closed"));
      });

      socket.on("data", (data) => { splitter.feed(data.toString()); });

      // Wait for "connected" response after sending "connect"
      let handshakeDone = false;

      splitter.onLine((line) => {
        const msg = parseLine(line) as DaemonResponse | null;
        if (!msg) return;

        // Forward logs even during handshake
        if (msg.type === "log") {
          console.error(msg.message);
          return;
        }

        if (!handshakeDone && msg.type === "connected") {
          handshakeDone = true;
          clearTimeout(timeout);
          this.socket = socket;
          this.splitter = splitter;
          if (msg.recommendedBatchSize !== undefined) {
            this.recommendedBatchSize = msg.recommendedBatchSize;
          }
          this.startHeartbeat();
          resolve();
          return;
        }

        if (!handshakeDone && msg.type === "error") {
          handshakeDone = true;
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(msg.message));
          return;
        }

        // Route responses after handshake
        this.handleResponse(msg);
      });

      // Once TCP connection is established, send connect message
      socket.on("connect", () => {
        const req: DaemonRequest = {
          type: "connect",
          model: this.model,
          device: this.device,
          ...(this.cacheDir ? { cacheDir: this.cacheDir } : {}),
        };
        socket.write(serialize(req));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Response routing
  // ---------------------------------------------------------------------------

  private handleResponse(msg: DaemonResponse): void {
    switch (msg.type) {
      case "result": {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.embeddings);
        }
        break;
      }

      case "error": {
        // Daemon-level error (not tied to a specific request id)
        // Could be a general error — reject oldest pending or log
        // For now, reject all pending since we don't have request id
        this.rejectAllPending(new Error(msg.message));
        break;
      }

      /* v8 ignore next 3 -- logs intercepted in onLine callback before reaching handleResponse */
      case "log":
        console.error(msg.message);
        break;

      case "pong":
        // Heartbeat acknowledged, nothing to do
        break;

      case "bye":
        // Server confirmed disconnect
        break;

      case "status":
      case "connected":
        // Informational responses — not expected during normal client flow
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    /* v8 ignore start */
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(serialize({ type: "heartbeat" }));
      }
    }, HEARTBEAT_INTERVAL_MS);
    /* v8 ignore stop */
    // Don't prevent process exit
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup helpers
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    this.stopHeartbeat();
    this.socket = null;
    this.splitter = null;
    this.connectPromise = null;
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }

  // ---------------------------------------------------------------------------
  // EmbeddingProvider implementation
  // ---------------------------------------------------------------------------

  async embed(text: string): Promise<EmbeddingResult> {
    await this.ensureInitialized();

    const id = this.nextId++;
    const { socket } = this;
    if (!socket) throw new Error("Socket not connected");

    const embeddings = await new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(serialize({ type: "embed", id, texts: [text] }));
    });

    return {
      embedding: embeddings[0],
      dimensions: this.dimensions,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    await this.ensureInitialized();

    const { socket } = this;
    if (!socket) throw new Error("Socket not connected");

    const id = this.nextId++;
    const embeddings = await new Promise<number[][]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(serialize({ type: "embed", id, texts }));
    });

    return embeddings.map((embedding) => ({
      embedding,
      dimensions: this.dimensions,
    }));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  /** Eagerly initialize connection to daemon (for batch size calibration) */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  async terminate(): Promise<void> {
    if (!this.socket || this.socket.destroyed) {
      this.cleanup();
      return;
    }

    const {socket} = this;

    try {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };

        socket.on("close", done);

        socket.write(serialize({ type: "disconnect" }));

        // Give 500ms for graceful disconnect, then force
        setTimeout(() => {
          /* v8 ignore start */
          if (!socket.destroyed) {
            socket.destroy();
          }
          /* v8 ignore stop */
          done();
        }, 500);
      });
    } catch {
      // Ignore errors during terminate
    } finally {
      /* v8 ignore start */
      if (!socket.destroyed) {
        socket.destroy();
      }
      /* v8 ignore stop */
      this.cleanup();
    }
  }
}
