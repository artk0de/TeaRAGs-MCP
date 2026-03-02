import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

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
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const path = ((rawSignals.relativePath as string) || "").toLowerCase();
    return RISKY_PATH_PATTERNS.some((p) => path.includes(p)) ? 1 : 0;
  }
}
