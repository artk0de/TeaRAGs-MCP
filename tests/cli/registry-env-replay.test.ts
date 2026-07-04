import { describe, expect, it } from "vitest";

import { replayTuningEnv } from "../../src/cli/registry-env-replay.js";

describe("replayTuningEnv", () => {
  it("fills unset target keys from the tuning snapshot (registry fills the gaps)", () => {
    const target: Record<string, string> = {};
    replayTuningEnv({ GIT_ADAPTER: "es-git", TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
    expect(target.TRAJECTORY_GIT_CHUNK_CONCURRENCY).toBe("5");
  });

  it("keeps an already-set non-empty target value (env > registry)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayTuningEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("git");
  });

  it("treats an empty-string target value as unset (matching envWithFallback)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "" };
    replayTuningEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
  });

  it("skips empty-string snapshot values (hand-edited registry) so they don't poison the env", () => {
    const target: Record<string, string> = {};
    replayTuningEnv({ GIT_ADAPTER: "" }, target);
    expect("GIT_ADAPTER" in target).toBe(false);
  });

  it("is a no-op for an undefined snapshot (legacy entry without tuning)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayTuningEnv(undefined, target);
    expect(target).toEqual({ GIT_ADAPTER: "git" });
  });
});
