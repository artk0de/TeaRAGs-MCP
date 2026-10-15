/**
 * Client of the GPU session broker on the Kev host (kev-rocm-serving
 * `broker/`, port 8008). A lease stops every embedding llama-server on the
 * card and starts Kev; releasing it brings the embedders back.
 */

import { KevSessionBusyError, KevSessionLostError, KevSessionUnavailableError } from "./errors.js";

/**
 * POST /v1/session blocks for the quiet window plus the switch (~75 s) and up
 * to drainTimeoutSec + kevStartTimeoutSec when the host is slow.
 */
const ACQUIRE_TIMEOUT_MS = 480_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface KevSessionClientOptions {
  url: string;
  /** Sent as `X-Broker-Token` when the broker is configured with one. */
  token?: string;
}

export interface KevSessionClientDeps {
  fetch?: typeof fetch;
}

export interface KevSession {
  lease: string;
  kevUrl: string;
  /** Unix epoch seconds on the broker's clock. */
  expiresAt: number;
}

export interface KevBrokerState {
  /** `EMBED` | `SWITCHING_TO_KEV` | `KEV` | `SWITCHING_TO_EMBED`. */
  state: string;
  /** The Kev run the broker starts, e.g. `jaredpalmer/kev-4b@v1.0`. */
  kevRun?: string;
}

interface StateResponse {
  state?: string;
  kev?: { run?: string };
}

export class KevSessionClient {
  readonly url: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(options: KevSessionClientOptions, deps: KevSessionClientDeps = {}) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchFn = deps.fetch ?? (async (input, init) => fetch(input, init));
  }

  async state(): Promise<KevBrokerState> {
    const response = await this.send("GET", "/v1/state", undefined, REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new KevSessionUnavailableError(this.url, `GET /v1/state answered HTTP ${response.status}`);
    const body = (await response.json()) as StateResponse;
    return {
      state: body.state ?? "unknown",
      ...(typeof body.kev?.run === "string" ? { kevRun: body.kev.run } : {}),
    };
  }

  /** Blocks until the embedders are stopped and Kev answers. */
  async acquire(holder: string, ttlSec: number): Promise<KevSession> {
    const response = await this.send("POST", "/v1/session", { holder, ttlSec }, ACQUIRE_TIMEOUT_MS);
    if (response.status === 409) {
      const body = (await response.json()) as { holder?: string; state?: string };
      throw new KevSessionBusyError(this.url, body.holder, body.state);
    }
    if (response.status === 503) {
      const body = (await response.json()) as { reason?: string };
      throw new KevSessionUnavailableError(this.url, body.reason ?? "broker refused the session");
    }
    if (!response.ok) {
      throw new KevSessionUnavailableError(this.url, `POST /v1/session answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as Partial<KevSession>;
    if (typeof body.lease !== "string" || typeof body.kevUrl !== "string") {
      throw new KevSessionUnavailableError(this.url, "POST /v1/session answered without lease or kevUrl");
    }
    return { lease: body.lease, kevUrl: body.kevUrl, expiresAt: body.expiresAt ?? 0 };
  }

  /** Extends the lease by its ttl; a 404 means the broker dropped it. */
  async heartbeat(lease: string): Promise<void> {
    const response = await this.send(
      "POST",
      `/v1/session/${encodeURIComponent(lease)}/heartbeat`,
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    if (response.status === 404) throw new KevSessionLostError(this.url, lease);
    if (!response.ok) throw new KevSessionUnavailableError(this.url, `heartbeat answered HTTP ${response.status}`);
  }

  /** The broker restores the embedders asynchronously; a lease it no longer knows (404) is already released. */
  async release(lease: string): Promise<void> {
    const response = await this.send(
      "DELETE",
      `/v1/session/${encodeURIComponent(lease)}`,
      undefined,
      REQUEST_TIMEOUT_MS,
    );
    if (!response.ok && response.status !== 404) {
      throw new KevSessionUnavailableError(this.url, `DELETE /v1/session answered HTTP ${response.status}`);
    }
  }

  private async send(method: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token !== undefined) headers["x-broker-token"] = this.token;
    try {
      return await this.fetchFn(`${this.url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new KevSessionUnavailableError(
        this.url,
        `${method} ${path} did not reach the broker`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}
