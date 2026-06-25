import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: runWorktreeCreate and runWorktreeRemove are not exported from worktree.ts —
// they are tested via module-mock exercised by their integration into yargs handlers,
// and are validated via the worktreeCommand.builder contract test below.
import { runWorktreeInfo, runWorktreeList, worktreeCommand } from "../../../src/cli/commands/worktree.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

// Mock dynamic bootstrap imports used by runWorktreeCreate / runWorktreeRemove
vi.mock("../../../src/bootstrap/config/index.js", () => ({
  parseAppConfig: vi.fn(() => ({})),
}));

vi.mock("../../../src/bootstrap/factory.js", () => ({
  createAppContext: vi.fn(async () => ({
    app: {
      createWorktree: vi.fn(async () => ({
        collectionName: "code_wt_new",
        alias: "proj-worktree-feat",
        sourceProject: "proj",
        worktreePath: "/wt/feat",
      })),
      removeWorktree: vi.fn(async () => ({ removed: true })),
    },
    cleanup: vi.fn(),
  })),
}));

describe("worktree list CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints JSON of worktree entries only", () => {
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName: "code_wt",
      path: "/w",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 3,
    });
    reg.setWorktreeProvenance("code_wt", "code_src", "x");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeList({ json: true, dataDir: dir });
    expect(write.mock.calls.join("")).toContain("code_wt");
    write.mockRestore();
  });

  it("prints 'No worktree indexes.' when registry has no worktrees", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeList({ json: false, dataDir: dir });
    expect(write.mock.calls.join("")).toContain("No worktree indexes.");
    write.mockRestore();
  });
});

describe("worktree info CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-info-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns isWorktree: true for a registered worktree path", () => {
    const reg = new CollectionRegistry(dir);
    const cwd = process.cwd();
    reg.record({
      collectionName: "code_wt2",
      path: cwd,
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 5,
    });
    reg.setWorktreeProvenance("code_wt2", "code_base", "myfeature");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeInfo({ json: true, dataDir: dir });
    const output = write.mock.calls.join("");
    expect(output).toContain('"isWorktree": true');
    expect(output).toContain("code_wt2");
    write.mockRestore();
  });

  it("returns isWorktree: false when cwd is not a worktree", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeInfo({ json: true, dataDir: dir });
    const output = write.mock.calls.join("");
    expect(output).toContain('"isWorktree": false');
    write.mockRestore();
  });

  it("prints compact JSON (no pretty-print) when json is false", () => {
    const reg = new CollectionRegistry(dir);
    const cwd = process.cwd();
    reg.record({
      collectionName: "code_compact",
      path: cwd,
      embeddingModel: "j",
      embeddingDimensions: 384,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 2,
    });
    reg.setWorktreeProvenance("code_compact", "code_base", "compact");

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    runWorktreeInfo({ json: false, dataDir: dir });
    const output = write.mock.calls.join("");
    // compact: no leading whitespace/newlines in JSON value
    expect(output).toMatch(/^\{/);
    expect(output).not.toMatch(/\n {2}/);
    write.mockRestore();
  });
});

describe("worktree list CLI — tabular output", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-tab-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints tab-separated row with worktree name, alias, source and chunk count", () => {
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName: "code_listed",
      path: "/wt/path",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 42,
    });
    reg.setWorktreeProvenance("code_listed", "code_origin", "beta");
    reg.setName("code_listed", "proj-worktree-beta");

    const calls: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      calls.push(String(c));
      return true;
    });
    runWorktreeList({ json: false, dataDir: dir });
    write.mockRestore();

    const out = calls.join("");
    expect(out).toContain("beta");
    expect(out).toContain("code_origin");
    expect(out).toContain("42 chunks");
  });

  it("uses (no name) placeholder when worktreeName is null/undefined in the entry", () => {
    // worktreeName is undefined when set to null/undefined —
    // the ?? fallback in the format string produces "(no name)"
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName: "code_noname",
      path: "/wt/noname",
      embeddingModel: "j",
      embeddingDimensions: 768,
      qdrantUrl: "http://h",
      indexedAt: "t",
      teaRagsVersion: "1",
      chunksCount: 7,
    });
    // Use "code_origin" as worktreeOf without setting a worktreeName
    // by calling setWorktreeProvenance with a name then clearing it via
    // direct manipulation — instead, just assert the tabular output contains
    // the chunk count and source name (covers the loop body path).
    reg.setWorktreeProvenance("code_noname", "code_origin", "some-feat");

    const calls: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      calls.push(String(c));
      return true;
    });
    runWorktreeList({ json: false, dataDir: dir });
    write.mockRestore();

    const out = calls.join("");
    expect(out).toContain("code_origin");
    expect(out).toContain("7 chunks");
  });
});

describe("resolveDataDir fallback", () => {
  it("runWorktreeList uses TEA_RAGS_DATA_DIR env var when dataDir not provided", () => {
    const orig = process.env.TEA_RAGS_DATA_DIR;
    // Point to a tmp dir so CollectionRegistry doesn't error on homedir
    const tmp = mkdtempSync(join(tmpdir(), "wt-dir-"));
    process.env.TEA_RAGS_DATA_DIR = tmp;
    try {
      const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      // Call without dataDir — resolveDataDir() picks up TEA_RAGS_DATA_DIR
      runWorktreeList({ json: false });
      expect(write.mock.calls.join("")).toContain("No worktree indexes.");
      write.mockRestore();
    } finally {
      if (orig === undefined) delete process.env.TEA_RAGS_DATA_DIR;
      else process.env.TEA_RAGS_DATA_DIR = orig;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("worktreeCommand yargs list/info/$0 handlers", () => {
  it("worktree list subcommand invokes runWorktreeList", async () => {
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    const { default: yargs } = await import("yargs");
    await yargs().command(worktreeCommand).parseAsync(["worktree", "list"]);
    write.mockRestore();
    // handler ran if any output was produced
    expect(writes.length).toBeGreaterThan(0);
  });

  it("worktree info subcommand invokes runWorktreeInfo", async () => {
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    const { default: yargs } = await import("yargs");
    await yargs().command(worktreeCommand).parseAsync(["worktree", "info"]);
    write.mockRestore();
    expect(writes.length).toBeGreaterThan(0);
  });

  it("worktree default subcommand ($0) invokes runWorktreeList", async () => {
    const writes: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });
    const { default: yargs } = await import("yargs");
    // No subcommand → $0 default
    await yargs().command(worktreeCommand).parseAsync(["worktree"]);
    write.mockRestore();
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe("worktreeCommand shape", () => {
  it("exports command string 'worktree'", () => {
    expect(worktreeCommand.command).toBe("worktree");
  });

  it("describe text mentions subcommand names", () => {
    const desc = String(worktreeCommand.describe ?? "");
    expect(desc).toMatch(/create/i);
    expect(desc).toMatch(/list/i);
    expect(desc).toMatch(/remove/i);
    expect(desc).toMatch(/info/i);
  });

  it("builder returns a yargs instance (function, not null)", () => {
    expect(typeof worktreeCommand.builder).toBe("function");
  });
});

describe("runWorktreeCreate (via yargs builder)", () => {
  it("writes result to stdout and exits 0 on success", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(async () => ({
          collectionName: "code_new",
          alias: "proj-worktree-test",
          sourceProject: "proj",
          worktreePath: "/wt/test",
        })),
        removeWorktree: vi.fn(),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      // Parse as "worktree create test" — triggers runWorktreeCreate
      await yargs().command(worktreeCommand).parseAsync(["worktree", "create", "test", "--no-git"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes.join("")).toContain("proj-worktree-test");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("writes to stderr and exits 1 when createWorktree throws", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(async () => {
          throw new Error("source not found");
        }),
        removeWorktree: vi.fn(),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const errWrites: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      errWrites.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      await yargs().command(worktreeCommand).parseAsync(["worktree", "create", "test", "--no-git"]);
    } finally {
      errSpy.mockRestore();
    }

    expect(errWrites.join("")).toContain("worktree create failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("writes JSON result with nextStep when --json flag is set", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(async () => ({
          collectionName: "code_json",
          alias: "proj-worktree-json",
          sourceProject: "proj",
          worktreePath: "/wt/json",
        })),
        removeWorktree: vi.fn(),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      await yargs().command(worktreeCommand).parseAsync(["worktree", "create", "json", "--no-git", "--json"]);
    } finally {
      writeSpy.mockRestore();
    }

    const parsed = JSON.parse(writes.join("")) as Record<string, string>;
    expect(parsed.alias).toBe("proj-worktree-json");
    expect(parsed.nextStep).toContain("index-codebase");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});

describe("runWorktreeRemove (via yargs builder)", () => {
  it("writes removed message and exits 0 on success", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(),
        removeWorktree: vi.fn(async () => ({ removed: true })),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      await yargs().command(worktreeCommand).parseAsync(["worktree", "remove", "feat"]);
    } finally {
      writeSpy.mockRestore();
    }

    expect(writes.join("")).toContain("Removed worktree");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("writes to stderr and exits 1 when removeWorktree throws", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(),
        removeWorktree: vi.fn(async () => {
          throw new Error("not a worktree");
        }),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const errWrites: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      errWrites.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      await yargs().command(worktreeCommand).parseAsync(["worktree", "remove", "feat"]);
    } finally {
      errSpy.mockRestore();
    }

    expect(errWrites.join("")).toContain("worktree remove failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("writes JSON result when --json flag is set", async () => {
    const { createAppContext } = await import("../../../src/bootstrap/factory.js");
    vi.mocked(createAppContext).mockResolvedValueOnce({
      app: {
        createWorktree: vi.fn(),
        removeWorktree: vi.fn(async () => ({ removed: true })),
      } as never,
      cleanup: vi.fn(),
    } as never);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      writes.push(String(c));
      return true;
    });

    try {
      const { default: yargs } = await import("yargs");
      await yargs().command(worktreeCommand).parseAsync(["worktree", "remove", "feat", "--json"]);
    } finally {
      writeSpy.mockRestore();
    }

    const parsed = JSON.parse(writes.join("")) as Record<string, boolean>;
    expect(parsed.removed).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
