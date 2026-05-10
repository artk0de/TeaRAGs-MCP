/**
 * Lightweight Qdrant readiness ping for SessionStart fast-fail.
 * Returns true if /readyz responds OK within `timeoutMs`. False on any error or timeout.
 */
export async function pingQdrant(url: string, timeoutMs = 200): Promise<boolean> {
  try {
    const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}
