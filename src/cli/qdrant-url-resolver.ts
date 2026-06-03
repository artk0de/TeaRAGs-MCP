import { resolveQdrantUrl } from "../core/api/public/index.js";

export interface TuneQdrantResolution {
  /** URL to pass to the benchmark child. `undefined` only when the caller
   *  explicitly opted out (e.g. inherited from a parent shell env). */
  url: string | undefined;
  /** Decrements the embedded-daemon refcount. Call exactly once after the
   *  benchmark child exits, so the idle watcher can shut the daemon down. */
  release?: () => void;
}

export interface ResolveTuneQdrantUrlOpts {
  /** Injected for tests; defaults to the real embedded-daemon resolver. */
  resolveEmbedded?: typeof resolveQdrantUrl;
  /** Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Qdrant URL for `tea-rags tune` and return a handle that releases
 * the embedded daemon ref (if any) when the benchmark finishes.
 *
 * Cascade:
 *   1. Explicit `--qdrant-url` from the caller → use as-is, no daemon touch.
 *   2. `QDRANT_URL` env var → pass through, no daemon touch.
 *   3. Otherwise delegate to the embedded daemon resolver, which probes
 *      `http://localhost:6333` first and falls back to spawning / attaching
 *      to `~/.tea-rags/qdrant` (binding a random port written to
 *      `daemon.port`). Tune needs this because the install wizard runs it
 *      BEFORE the MCP harness is configured — there is no other agent on
 *      the system that would have woken the daemon yet.
 */
export async function resolveTuneQdrantUrl(
  explicit: string | undefined,
  opts: ResolveTuneQdrantUrlOpts = {},
): Promise<TuneQdrantResolution> {
  const env = opts.env ?? process.env;
  if (explicit) return { url: explicit };
  if (env.QDRANT_URL) return { url: env.QDRANT_URL };

  const resolve = opts.resolveEmbedded ?? resolveQdrantUrl;
  const resolution = await resolve();
  return {
    url: resolution.url,
    release: resolution.mode === "embedded" ? resolution.release : undefined,
  };
}
