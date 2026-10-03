/**
 * Provider-agnostic health tracking for a set of embedding endpoints that serve
 * the same model.
 *
 * Endpoints come in two tiers: PEERS (the remote endpoints a provider spreads
 * load across) and FALLBACKS (served only while every peer has failed). An
 * endpoint fails immediately on a refused connection, or after
 * `failoverConsecutiveFailures` consecutive transient failures. Failed
 * endpoints are re-admitted by `probeFailed()`; the pool owns no timer — the
 * provider schedules the probe at `probeIntervalMs`.
 *
 * Each endpoint also carries an EWMA throughput in chars/s, which the batch
 * fan-out uses as its split weight.
 */

export type EmbeddingEndpointTier = "peer" | "fallback";

export interface EmbeddingEndpointState {
  url: string;
  tier: EmbeddingEndpointTier;
  healthy: boolean;
  consecutiveFailures: number;
  /** EWMA of measured throughput; undefined until the first timed success. */
  charsPerSecond?: number;
}

export interface EmbeddingEndpointPoolConfig {
  peers: string[];
  fallbacks: string[];
  /** Consecutive transient failures that fail an endpoint; 0 disables count-based failover. */
  failoverConsecutiveFailures: number;
  /** Minimum gap between two probes of the same failed endpoint. */
  probeIntervalMs: number;
  /** Health check for one endpoint (e.g. GET /health). A throw counts as a failed probe. */
  probe: (url: string) => Promise<boolean>;
  now?: () => number;
  /** EWMA smoothing factor for throughput samples. Default 0.3. */
  ewmaAlpha?: number;
}

const DEFAULT_EWMA_ALPHA = 0.3;

interface TrackedEmbeddingEndpoint extends EmbeddingEndpointState {
  /** Timestamp of the last probe while failed; cleared when the endpoint fails anew. */
  lastProbeAt?: number;
}

const BARE_PORT = /^:?(\d+)$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Split a comma-separated endpoint list: trim, drop empties, strip trailing "/".
 * Shorthand for several servers on one host: a bare port (`8082` or `:8082`)
 * reuses the scheme and host of the nearest preceding URL
 * (`http://box:8081,8082` → two endpoints); with no preceding URL it means
 * `http://localhost`. A `host:port` entry without a scheme gets `http://`.
 */
export function parseEmbeddingEndpointList(value: string | undefined): string[] {
  if (!value) return [];
  const endpoints: string[] = [];
  let base = "http://localhost";
  for (const raw of value.split(",")) {
    const entry = raw.trim().replace(/\/+$/, "");
    if (entry.length === 0) continue;
    const port = BARE_PORT.exec(entry);
    if (port) {
      endpoints.push(`${base}:${port[1]}`);
      continue;
    }
    const url = HAS_SCHEME.test(entry) ? entry : `http://${entry}`;
    endpoints.push(url);
    base = url.replace(/:\d+$/, "");
  }
  return endpoints;
}

export class EmbeddingEndpointPool {
  private readonly endpoints: TrackedEmbeddingEndpoint[];
  private readonly peers: readonly string[];
  private readonly fallbacks: readonly string[];
  private readonly failoverConsecutiveFailures: number;
  private readonly probeIntervalMs: number;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly ewmaAlpha: number;

  constructor(config: EmbeddingEndpointPoolConfig) {
    this.peers = [...config.peers];
    this.fallbacks = [...config.fallbacks];
    this.failoverConsecutiveFailures = config.failoverConsecutiveFailures;
    this.probeIntervalMs = config.probeIntervalMs;
    this.probe = config.probe;
    this.now = config.now ?? Date.now;
    this.ewmaAlpha = config.ewmaAlpha ?? DEFAULT_EWMA_ALPHA;
    this.endpoints = [
      ...this.peers.map((url) => newEndpoint(url, "peer")),
      ...this.fallbacks.map((url) => newEndpoint(url, "fallback")),
    ];
  }

  /** Healthy endpoints of the active tier: peers if any healthy, else fallbacks. */
  activeEndpoints(): EmbeddingEndpointState[] {
    const tier = this.activeTier();
    if (!tier) return [];
    return this.endpoints.filter((e) => e.tier === tier && e.healthy).map(toState);
  }

  /** Tier currently serving; undefined when no endpoint is healthy. */
  activeTier(): EmbeddingEndpointTier | undefined {
    if (this.endpoints.some((e) => e.tier === "peer" && e.healthy)) return "peer";
    if (this.endpoints.some((e) => e.tier === "fallback" && e.healthy)) return "fallback";
    return undefined;
  }

  /** First healthy active endpoint, else the first configured peer. */
  primaryUrl(): string {
    return this.activeEndpoints()[0]?.url ?? this.peers[0];
  }

  configuredPeersLabel(): string {
    return this.peers.join(",");
  }

  configuredFallbacksLabel(): string | undefined {
    return this.fallbacks.length > 0 ? this.fallbacks.join(",") : undefined;
  }

  /** A success resets the failure counter and feeds the throughput EWMA. */
  recordSuccess(url: string, chars: number, durationMs: number): void {
    const endpoint = this.find(url);
    if (!endpoint) return;
    endpoint.consecutiveFailures = 0;
    if (durationMs <= 0) return;
    const sample = (chars * 1000) / durationMs;
    endpoint.charsPerSecond =
      endpoint.charsPerSecond === undefined
        ? sample
        : this.ewmaAlpha * sample + (1 - this.ewmaAlpha) * endpoint.charsPerSecond;
  }

  /** "refused" fails the endpoint immediately; "transient" counts toward the threshold. */
  recordEndpointFailure(url: string, kind: "refused" | "transient"): void {
    const endpoint = this.find(url);
    if (!endpoint) return;
    endpoint.consecutiveFailures += 1;
    const thresholdReached =
      this.failoverConsecutiveFailures > 0 && endpoint.consecutiveFailures >= this.failoverConsecutiveFailures;
    if (kind === "refused" || thresholdReached) this.markFailed(endpoint);
  }

  /**
   * Re-probe failed endpoints and re-admit those whose probe succeeds. An
   * endpoint probed less than `probeIntervalMs` ago is skipped, so the call is
   * safe from both the provider's timer and an opportunistic caller.
   */
  async probeFailed(): Promise<void> {
    const now = this.now();
    const due = this.endpoints.filter(
      (e) => !e.healthy && (e.lastProbeAt === undefined || now - e.lastProbeAt >= this.probeIntervalMs),
    );
    await Promise.all(
      due.map(async (endpoint) => {
        endpoint.lastProbeAt = now;
        if (await this.safeProbe(endpoint.url)) this.markHealthy(endpoint);
      }),
    );
  }

  /** Probe every peer, update its health; true when at least one peer is up. */
  async checkPeersHealth(): Promise<boolean> {
    return this.checkTierHealth("peer");
  }

  /** Probe every fallback, update its health; undefined when none is configured. */
  async checkFallbacksHealth(): Promise<boolean | undefined> {
    if (this.fallbacks.length === 0) return undefined;
    return this.checkTierHealth("fallback");
  }

  snapshot(): EmbeddingEndpointState[] {
    return this.endpoints.map(toState);
  }

  private async checkTierHealth(tier: EmbeddingEndpointTier): Promise<boolean> {
    const members = this.endpoints.filter((e) => e.tier === tier);
    const results = await Promise.all(
      members.map(async (endpoint) => {
        const ok = await this.safeProbe(endpoint.url);
        if (ok) this.markHealthy(endpoint);
        else this.markFailed(endpoint);
        return ok;
      }),
    );
    return results.some(Boolean);
  }

  private async safeProbe(url: string): Promise<boolean> {
    try {
      return await this.probe(url);
    } catch {
      return false;
    }
  }

  private markFailed(endpoint: TrackedEmbeddingEndpoint): void {
    if (endpoint.healthy) endpoint.lastProbeAt = undefined;
    endpoint.healthy = false;
  }

  private markHealthy(endpoint: TrackedEmbeddingEndpoint): void {
    endpoint.healthy = true;
    endpoint.consecutiveFailures = 0;
    endpoint.lastProbeAt = undefined;
  }

  private find(url: string): TrackedEmbeddingEndpoint | undefined {
    return this.endpoints.find((e) => e.url === url);
  }
}

function newEndpoint(url: string, tier: EmbeddingEndpointTier): TrackedEmbeddingEndpoint {
  return { url, tier, healthy: true, consecutiveFailures: 0 };
}

function toState(endpoint: TrackedEmbeddingEndpoint): EmbeddingEndpointState {
  const state: EmbeddingEndpointState = {
    url: endpoint.url,
    tier: endpoint.tier,
    healthy: endpoint.healthy,
    consecutiveFailures: endpoint.consecutiveFailures,
  };
  if (endpoint.charsPerSecond !== undefined) state.charsPerSecond = endpoint.charsPerSecond;
  return state;
}
