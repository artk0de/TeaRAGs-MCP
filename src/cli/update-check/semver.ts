const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/**
 * Strict X.Y.Z semver check. Prerelease tags (-rc.1, -beta) and build
 * metadata (+sha) are intentionally rejected — npm registry's `latest`
 * dist-tag never points at a prerelease, so accepting them would mask
 * a malformed response rather than help.
 */
export function isValidSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

/**
 * Returns -1, 0, or 1 depending on whether a is less than, equal to, or
 * greater than b. Throws on non-semver inputs — programming invariant.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  if (!isValidSemver(a)) throw new Error(`compareSemver: invalid semver a=${a}`);
  if (!isValidSemver(b)) throw new Error(`compareSemver: invalid semver b=${b}`);
  const [a1, a2, a3] = a.split(".").map((n) => parseInt(n, 10));
  const [b1, b2, b3] = b.split(".").map((n) => parseInt(n, 10));
  if (a1 !== b1) return a1 < b1 ? -1 : 1;
  if (a2 !== b2) return a2 < b2 ? -1 : 1;
  if (a3 !== b3) return a3 < b3 ? -1 : 1;
  return 0;
}
