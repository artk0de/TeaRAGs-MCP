import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

// Exact security tokens — matched against path tokens, NOT raw substrings.
// "access" is deliberately excluded: it is a precision killer (data-access/,
// accessibility/, AccessorUtils) with near-zero recall value — real security
// paths use acl/permission/rbac. Real auth code keeps the "auth" token; the
// "author" false positive is excluded because "author" is never tokenized to
// "auth".
const SECURITY_TOKENS = new Set([
  "auth",
  "authn",
  "authz",
  "authentication",
  "authorization",
  "security",
  "crypto",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "permission",
  "permissions",
  "acl",
  "oauth",
  "jwt",
  "sso",
]);

/**
 * Split a path into lowercased tokens on segment, separator, and camelCase
 * boundaries: "src/AccessorUtils.ts" -> [src, accessor, utils, ts]. This is the
 * core of the false-positive fix — "author-counts.ts" tokenizes to
 * [author, counts, ts] so "auth" never matches, and "tokenizer.ts" tokenizes to
 * [tokenizer, ts] so "token" never matches.
 */
function pathTokens(rawPath: string): string[] {
  return rawPath
    .split("/")
    .flatMap((segment) => segment.split(/[-_.\s]+/))
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/))
    .map((token) => token.toLowerCase())
    .filter(Boolean);
}

/**
 * Binary signal: does the file path contain a security-sensitive token?
 *
 * Purpose: flag code in auth/crypto/security paths for priority review.
 * Detects: paths whose segments tokenize to a known security keyword (auth,
 *   security, crypto, password, secret, token, credential, permission, acl,
 *   oauth, jwt, sso) — regardless of content.
 * Scoring: 1.0 if any path token is a security token, 0.0 otherwise.
 * Used in: securityAudit preset (boost security-critical paths).
 * Limitation: path-based heuristic — won't catch security code in generic paths.
 *   Matches on token (segment/word) boundaries, not raw substrings, so
 *   author-*, accessibility, tokenizer, data-access no longer false-positive.
 */
export class PathRiskSignal implements DerivedSignalDescriptor {
  readonly name = "pathRisk";
  readonly description = "Security-sensitive path pattern match (1 if matches, 0 otherwise)";
  readonly sources: string[] = [];
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const path = (rawSignals.relativePath as string) || "";
    if (!path) return 0;
    return pathTokens(path).some((token) => SECURITY_TOKENS.has(token)) ? 1 : 0;
  }
}
