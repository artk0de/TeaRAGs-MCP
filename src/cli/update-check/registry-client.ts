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

const REGISTRY_BASE = "https://registry.npmjs.org";

export class NpmRegistryClient implements RegistryClient {
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
