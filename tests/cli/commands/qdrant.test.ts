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

/**
 * bd tea-rags-mcp-lvlwc — the production wiring behind `qdrant recover`: the
 * Qdrant endpoint the PROJECT's registry entry addresses (embedded daemon,
 * external URL) else the configured default, the outcome rendered on stdout,
 * and the embedded daemon ref released before the process exits.
 */
describe("qdrantCommand recover — production wiring", () => {
  type Backend = { kind: "embedded" } | { kind: "external"; url: string } | { kind: "unaddressed" };

  async function runRecover(argv: string[], backend: Backend, entry: object | undefined) {
    vi.resetModules();
    const release = vi.fn();
    const lookups: string[] = [];
    const opened: { url: string; apiKey: string }[] = [];
    const resolvedFrom: string[] = [];
    const recover = vi.fn(async () => ({
      outcome: "nothing-to-do" as const,
      collectionName: "code_demo_v1",
      optimizerStatus: "ok",
    }));

    vi.doMock("../../../src/bootstrap/config/index.js", () => ({
      resolveRegistryEnvCodeDefaults: vi.fn(),
      parseAppConfig: () => ({ paths: { appData: "/tmp/app" }, qdrantUrl: "http://default:6333", qdrantApiKey: "key" }),
    }));
    vi.doMock("../../../src/core/api/index.js", () => ({
      OptimizerRecoveryOps: class {
        recover = recover;
      },
    }));
    vi.doMock("../../../src/core/api/public/index.js", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      EMBEDDED_MARKER: "embedded",
      CollectionRegistry: class {
        findByName(name: string): object | undefined {
          lookups.push(`name:${name}`);
          return entry;
        }
        findByPath(path: string): object | undefined {
          lookups.push(`path:${path}`);
          return entry;
        }
      },
      QdrantManager: class {
        constructor(url: string, apiKey: string) {
          opened.push({ url, apiKey });
        }
      },
      resolveRegistryQdrantBackend: () => backend,
      resolveQdrantUrl: async (from: string) => {
        resolvedFrom.push(from);
        return from === "embedded"
          ? { mode: "embedded", url: "http://127.0.0.1:7001", release }
          : { mode: "external", url: from };
      },
    }));

    const stdout: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const exitCodes: unknown[] = [];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
      exitCodes.push(code);
    }) as never);
    try {
      const { qdrantCommand: fresh } = await import("../../../src/cli/commands/qdrant.js");
      const { default: yargs } = await import("yargs");
      await yargs([]).command(fresh).exitProcess(false).parseAsync(argv);
    } finally {
      write.mockRestore();
      exitSpy.mockRestore();
      vi.doUnmock("../../../src/bootstrap/config/index.js");
      vi.doUnmock("../../../src/core/api/index.js");
      vi.doUnmock("../../../src/core/api/public/index.js");
    }
    return { release, lookups, opened, resolvedFrom, recover, stdout: stdout.join(""), exitCodes };
  }

  it("reattaches the embedded daemon of a registered alias and releases it on exit", async () => {
    const run = await runRecover(["qdrant", "recover", "--project", "demo"], { kind: "embedded" }, { name: "demo" });

    expect(run.lookups).toEqual(["name:demo"]);
    expect(run.resolvedFrom).toEqual(["embedded"]);
    expect(run.opened).toEqual([{ url: "http://127.0.0.1:7001", apiKey: "key" }]);
    expect(run.recover).toHaveBeenCalledWith({ project: "demo" });
    expect(run.stdout).toContain("nothing to do");
    expect(run.release).toHaveBeenCalledTimes(1);
    expect(run.exitCodes).toEqual([0]);
  });

  it("dials the external URL a path-addressed entry names", async () => {
    const run = await runRecover(
      ["qdrant", "recover", "--path", "/work/demo", "--json"],
      { kind: "external", url: "http://remote:6333" },
      { name: "demo" },
    );

    expect(run.lookups).toEqual(["path:/work/demo"]);
    expect(run.resolvedFrom).toEqual(["http://remote:6333"]);
    expect(run.opened).toEqual([{ url: "http://remote:6333", apiKey: "key" }]);
    expect(JSON.parse(run.stdout.trim())).toMatchObject({ outcome: "nothing-to-do", collectionName: "code_demo_v1" });
    expect(run.release).not.toHaveBeenCalled();
  });

  it("falls back to the configured Qdrant URL when the project has no registry entry", async () => {
    const run = await runRecover(["qdrant", "recover", "--project", "ghost"], { kind: "unaddressed" }, undefined);

    expect(run.resolvedFrom).toEqual(["http://default:6333"]);
    expect(run.opened).toEqual([{ url: "http://default:6333", apiKey: "key" }]);
    expect(run.exitCodes).toEqual([0]);
  });
});
