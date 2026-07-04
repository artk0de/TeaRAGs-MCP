/**
 * Bounded wait for embedded-Qdrant readiness (tea-rags-mcp-2nfdm).
 *
 * After a daemon restart, shard recovery of large collections blocks the HTTP
 * bind for tens of seconds to minutes; every indexing run during it used to
 * die instantly on INFRA_QDRANT_RECOVERING. The index worker wraps its
 * startup qdrant probe in this helper: not-ready states retry on a poll
 * interval inside a bounded window (reporting each wait via `onWait` so the
 * renderer can show the daemon state before any progress bars), everything
 * else — including a genuinely-unreachable external Qdrant — rethrows
 * immediately. MCP-side fail-fast semantics are untouched; the wait is a CLI
 * indexing concern only.
 *
 * Matching is structural (`code` property) so the CLI layer needs no error
 * class imports: INFRA_QDRANT_STARTING → "starting",
 * INFRA_QDRANT_RECOVERING → "recovering".
 */

export type QdrantWaitState = "starting" | "recovering";

const WAIT_STATE_BY_CODE: Record<string, QdrantWaitState> = {
  INFRA_QDRANT_STARTING: "starting",
  INFRA_QDRANT_RECOVERING: "recovering",
};

/** Recovery of ~GB-scale collections takes minutes; bound the wait so a wedged daemon still fails loud. */
const DEFAULT_READINESS_TIMEOUT_MS = 600_000;
/** Poll interval between attempts — recovery progress is not observable, so a coarse tick is enough. */
const DEFAULT_POLL_MS = 3_000;

export interface QdrantReadinessOptions {
  /** Bounded wait window (ms); the last readiness error rethrows once exhausted. Default 10 min. */
  timeoutMs?: number;
  /** Pause between attempts (ms). Default 3s. */
  pollMs?: number;
  /** Called before each pause with the daemon state and elapsed wait (ms). */
  onWait?: (state: QdrantWaitState, elapsedMs: number) => void;
  /** Injectable clock (ms). */
  now?: () => number;
  /** Injectable pause. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function awaitQdrantReadiness<T>(
  attempt: () => Promise<T>,
  options: QdrantReadinessOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      const state = typeof code === "string" ? WAIT_STATE_BY_CODE[code] : undefined;
      const elapsedMs = now() - start;
      if (state === undefined || elapsedMs >= timeoutMs) throw err;
      options.onWait?.(state, elapsedMs);
      await sleep(pollMs);
    }
  }
}
