import { describe, expect, it, vi } from "vitest";

import { qdrantCommand, runQdrantRecover, type QdrantRecoverDeps } from "../../../src/cli/commands/qdrant.js";
import { QdrantOptimizerErrorPersistsError } from "../../../src/core/api/public/index.js";

/**
 * `tea-rags qdrant recover` (bd tea-rags-mcp-ye5o, owner option B) — the CLI
 * surface over `OptimizerRecoveryOps#recover`. The op owns the Qdrant calls;
 * this handler owns addressing, rendering and the exit code.
 */
function harness(recover: QdrantRecoverDeps["recovery"]["recover"]) {
  const out: string[] = [];
  const errOut: string[] = [];
  const exit = vi.fn();
  const deps: QdrantRecoverDeps = {
    recovery: { recover: vi.fn(recover) },
    out: (line) => out.push(line),
    errOut: (line) => errOut.push(line),
    exit,
  };
  return { deps, out, errOut, exit };
}

describe("runQdrantRecover", () => {
  it("reports a cleared optimizer error and exits 0", async () => {
    const h = harness(async () => ({
      outcome: "cleared",
      collectionName: "code_abc_v2",
      previousOptimizerStatus: "error: segment optimization failed",
      optimizerStatus: "ok",
    }));

    await runQdrantRecover({ project: "demo", json: false }, h.deps);

    expect(h.deps.recovery.recover).toHaveBeenCalledWith({ project: "demo" });
    expect(h.out.join("\n")).toContain("code_abc_v2");
    expect(h.out.join("\n")).toContain("cleared");
    expect(h.out.join("\n")).toContain("error: segment optimization failed");
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("reports nothing to do when the optimizer is not failed and exits 0", async () => {
    const h = harness(async () => ({ outcome: "nothing-to-do", collectionName: "code_abc_v2", optimizerStatus: "ok" }));

    await runQdrantRecover({ project: "demo", json: false }, h.deps);

    expect(h.out.join("\n")).toContain("nothing to do");
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("addresses the project by an absolute path when no alias is given", async () => {
    const h = harness(async () => ({ outcome: "nothing-to-do", collectionName: "code_abc", optimizerStatus: "ok" }));

    await runQdrantRecover({ path: "/repo", json: false }, h.deps);

    expect(h.deps.recovery.recover).toHaveBeenCalledWith({ path: "/repo" });
  });

  it("emits the outcome as one JSON object with --json", async () => {
    const outcome = {
      outcome: "cleared" as const,
      collectionName: "code_abc_v2",
      previousOptimizerStatus: "error: boom",
      optimizerStatus: "ok",
    };
    const h = harness(async () => outcome);

    await runQdrantRecover({ project: "demo", json: true }, h.deps);

    expect(JSON.parse(h.out.join("\n"))).toEqual(outcome);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("renders a persisting optimizer error with its hint and exits 1", async () => {
    const h = harness(async () => {
      throw new QdrantOptimizerErrorPersistsError("code_abc_v2", "error: disk full");
    });

    await runQdrantRecover({ project: "demo", json: false }, h.deps);

    expect(h.errOut.join("\n")).toContain("disk full");
    expect(h.out).toEqual([]);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it("renders a typed failure as a JSON error object with --json", async () => {
    const h = harness(async () => {
      throw new QdrantOptimizerErrorPersistsError("code_abc_v2", "error: disk full");
    });

    await runQdrantRecover({ project: "demo", json: true }, h.deps);

    const payload = JSON.parse(h.out.join("\n")) as { error: { code: string; message: string; hint: string } };
    expect(payload.error.code).toBe("INFRA_QDRANT_OPTIMIZER_ERROR_PERSISTS");
    expect(h.exit).toHaveBeenCalledWith(1);
  });
});

describe("qdrantCommand", () => {
  it("is the `qdrant` namespace", () => {
    expect(qdrantCommand.command).toBe("qdrant");
  });
});
