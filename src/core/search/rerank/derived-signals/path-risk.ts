import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

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

export class PathRiskSignal implements DerivedSignalDescriptor {
  readonly name = "pathRisk";
  readonly description = "Security-sensitive path pattern match (1 if matches, 0 otherwise)";
  readonly sources: string[] = [];
  extract(payload: Record<string, unknown>): number {
    const path = ((payload.relativePath as string) || "").toLowerCase();
    return RISKY_PATH_PATTERNS.some((p) => path.includes(p)) ? 1 : 0;
  }
}
