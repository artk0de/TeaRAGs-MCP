import { isValidSemver } from "./semver.js";

export interface RegistryClient {
  /**
   * Returns the `latest` dist-tag version for the given package name.
   * Returns `null` for any expected failure (network error, non-OK
   * response, malformed JSON, non-semver version) so callers can map
   * the result to a domain status without try/catch.
   */
  fetchLatestVersion: (packageName: string, opts?: { timeoutMs?: number }) => Promise<string | null>;
}

/** A package's `latest` dist-tag and its `time` map (version → ISO publish time, plus `created`/`modified`). */
export interface NpmReleaseTimeline {
  latest: string;
  publishedAt: Record<string, string>;
}

const REGISTRY_BASE = "https://registry.npmjs.org";

export class NpmRegistryClient implements RegistryClient {
  /**
   * The full package document's `dist-tags.latest` and `time` map — the input
   * of the background update's canary window. Null on any failure, like
   * fetchLatestVersion.
   */
  async fetchReleaseTimeline(packageName: string, opts?: { timeoutMs?: number }): Promise<NpmReleaseTimeline | null> {
    const controller = new AbortController();
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            controller.abort();
          }, opts.timeoutMs)
        : null;
    try {
      const res = await globalThis.fetch(`${REGISTRY_BASE}/${packageName}`, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { "dist-tags"?: { latest?: unknown }; time?: unknown };
      const latest = body["dist-tags"]?.latest;
      if (typeof latest !== "string" || !isValidSemver(latest)) return null;
      if (typeof body.time !== "object" || body.time === null) return null;
      const publishedAt: Record<string, string> = {};
      for (const [key, value] of Object.entries(body.time)) {
        if (typeof value === "string") publishedAt[key] = value;
      }
      return { latest, publishedAt };
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async fetchLatestVersion(packageName: string, opts?: { timeoutMs?: number }): Promise<string | null> {
    const controller = new AbortController();
    const timer =
      opts?.timeoutMs !== undefined
        ? setTimeout(() => {
            controller.abort();
          }, opts.timeoutMs)
        : null;

    try {
      const url = `${REGISTRY_BASE}/${packageName}/latest`;
      const res = await globalThis.fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      const { version } = body;
      if (typeof version !== "string" || !isValidSemver(version)) return null;
      return version;
    } catch {
      // DNS, connect, abort, json parse — all treated as "unavailable".
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
