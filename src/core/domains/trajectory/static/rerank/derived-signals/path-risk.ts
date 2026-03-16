import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

const RISKY_PATH_PATTERNS = [
  "auth",
  "security",
  "crypto",
  "password",
  "secret",
  "token",
  "credential",
  "permission",
  "access",
];

/**
 * Binary signal: does the file path contain security-sensitive keywords?
 *
 * Purpose: flag code in auth/crypto/security paths for priority review.
 * Detects: files in auth, security, crypto, password, token, credential,
 *   permission, access directories — regardless of content.
 * Scoring: 1.0 if path matches any pattern, 0.0 otherwise.
 * Used in: securityAudit preset (boost security-critical paths).
 * Limitation: path-based heuristic — won't catch security code in generic paths.
 */
export class PathRiskSignal implements DerivedSignalDescriptor {
  readonly name = "pathRisk";
  readonly description = "Security-sensitive path pattern match (1 if matches, 0 otherwise)";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const path = ((rawSignals.relativePath as string) || "").toLowerCase();
    return RISKY_PATH_PATTERNS.some((p) => path.includes(p)) ? 1 : 0;
  }
}
