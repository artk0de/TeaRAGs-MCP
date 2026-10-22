import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runRustAnalyzerScip,
  RUST_ANALYZER_EXEC_SETTINGS,
  RUST_ANALYZER_NO_EXEC_SETTINGS,
  type RustAnalyzerCommandOutcome,
  type RustAnalyzerExecutable,
  type RustAnalyzerScipChild,
  type RustAnalyzerScipRunnerDeps,
  type RustAnalyzerScipRunOptions,
} from "../../../../src/core/adapters/rust-analyzer/index.js";

const MINI_SCIP = new Uint8Array(
  readFileSync(join(import.meta.dirname, "../../../fixtures/rust-analyzer-scip/mini/index.scip")),
);
const ROOT = "/p";
const DATA = "/data";
const RA: RustAnalyzerExecutable = {
  path: "/opt/homebrew/bin/rust-analyzer",
  tier: "homebrew",
  version: "0.0.0",
  commit: "abc1234",
  date: "2026-10-18",
};

/** How the fake rust-analyzer behaves on one spawn. */
interface ChildScript {
  exitCode?: number;
  /** Bytes written to `--output` before exit; absent = no file. */
  output?: Uint8Array;
  /** Text emitted on stdout/stderr. */
  log?: string;
  /** Never exits on its own — only a kill ends it. */
  hang?: boolean;
  /** `spawn` itself throws. */
  throws?: boolean;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

function host(
  init: {
    files?: Record<string, string>;
    rustupRustc?: Record<string, string>;
    rssKb?: number;
    scripts?: ChildScript[];
  } = {},
) {
  const texts = new Map<string, string>(Object.entries(init.files ?? { [`${ROOT}/Cargo.lock`]: "lock-v1" }));
  const bytes = new Map<string, Uint8Array>();
  const sources = [{ relPath: "src/main.rs", size: 10, mtimeMs: 1 }];
  const spawns: SpawnCall[] = [];
  const commands: { command: string; args: readonly string[] }[] = [];
  const kills: number[] = [];
  const scripts = [...(init.scripts ?? [])];
  let now = 0;
  let tick: (() => void) | undefined;
  let tmpCounter = 0;

  const deps: RustAnalyzerScipRunnerDeps = {
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    dataDir: DATA,
    run: (command, args): RustAnalyzerCommandOutcome => {
      commands.push({ command, args });
      if (command === "rustup" && args[0] === "which" && args[1] === "rustc") {
        const path = init.rustupRustc?.[String(args[3])];
        return path ? { kind: "ok", stdout: `${path}\n` } : { kind: "failed" };
      }
      if (args[0] === "-vV") return { kind: "ok", stdout: `rustc 1.88.0 (via ${command})\n` };
      return { kind: "failed" };
    },
    spawn: (command, args, options): RustAnalyzerScipChild => {
      spawns.push({ command, args, env: options.env });
      const script = scripts.shift() ?? { exitCode: 0, output: MINI_SCIP };
      if (script.throws) throw new Error("spawn ENOENT");
      let resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = resolve;
      });
      const pid = 4242 + spawns.length;
      if (script.log) options.onOutput(script.log);
      if (!script.hang) {
        const outPath = args[args.indexOf("--output") + 1] ?? "";
        if (script.output) bytes.set(outPath, script.output);
        resolveExit({ code: script.exitCode ?? 0, signal: null });
      }
      return {
        pid,
        exited,
        killTree: () => {
          kills.push(pid);
          resolveExit({ code: null, signal: "SIGKILL" });
        },
      };
    },
    sampleTreeRssKb: () => init.rssKb ?? 100_000,
    clock: {
      now: () => now,
      every: (_ms, fn) => {
        tick = fn;
        return () => {
          tick = undefined;
        };
      },
    },
    fs: {
      readBytes: (path) => bytes.get(path),
      readText: (path) => texts.get(path),
      writeTextAtomic: (path, text) => {
        texts.set(path, text);
      },
      remove: (path) => {
        for (const key of [...texts.keys()]) if (key.startsWith(path)) texts.delete(key);
        for (const key of [...bytes.keys()]) if (key.startsWith(path)) bytes.delete(key);
      },
      makeTempDir: () => `/tmp/ra-${++tmpCounter}`,
      listRustSources: () => sources,
    },
    readCargoManifests: () => [{ relDir: "", fileName: "Cargo.toml", content: '[package]\nname = "mini"\n' }],
  };
  return {
    deps,
    texts,
    sources,
    spawns,
    commands,
    kills,
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
  };
}

function options(overrides: Partial<RustAnalyzerScipRunOptions> = {}): RustAnalyzerScipRunOptions {
  return { projectRoot: ROOT, executable: RA, exec: false, timeoutSec: 900, maxRssMb: 4096, ...overrides };
}

function configWritten(h: ReturnType<typeof host>, spawnIndex = 0): unknown {
  const args = h.spawns[spawnIndex]?.args ?? [];
  const path = args[args.indexOf("--config-path") + 1] ?? "";
  const text = h.texts.get(path);
  return text === undefined ? undefined : JSON.parse(text);
}

/** The config file lives in the run's temp dir, removed on exit — capture it while the child runs. */
function captureConfig(h: ReturnType<typeof host>): { value: unknown } {
  const captured: { value: unknown } = { value: undefined };
  const { spawn } = h.deps;
  h.deps.spawn = (command, args, opts) => {
    const path = args[args.indexOf("--config-path") + 1] ?? "";
    captured.value = JSON.parse(h.texts.get(path) ?? "null");
    return spawn(command, args, opts);
  };
  return captured;
}

describe("runRustAnalyzerScip — invocation", () => {
  it("runs `scip <root>` with the no-exec config, offline cargo and vendored libraries excluded", async () => {
    const h = host();
    const config = captureConfig(h);
    const outcome = await runRustAnalyzerScip(options({ numThreads: 3 }), h.deps);
    expect(outcome.kind).toBe("indexed");
    const call = h.spawns[0];
    expect(call?.command).toBe(RA.path);
    expect(call?.args.slice(0, 2)).toEqual(["scip", ROOT]);
    expect(call?.args).toContain("--exclude-vendored-libraries");
    expect(call?.args.join(" ")).toContain("--num-threads 3");
    expect(config.value).toEqual(RUST_ANALYZER_NO_EXEC_SETTINGS);
    expect(RUST_ANALYZER_NO_EXEC_SETTINGS).toEqual({
      cargo: { buildScripts: { enable: false, overrideCommand: ["/usr/bin/true"] } },
      procMacro: { enable: false },
    });
    expect(call?.env.CARGO_NET_OFFLINE).toBe("true");
    expect(call?.env.RUSTC).toBeUndefined();
    expect(call?.env.RUSTUP_TOOLCHAIN).toBeUndefined();
    expect(call?.env.PATH).toBe("/usr/bin");
  });

  it("removes the run's temp dir (config + raw .scip) after the run", async () => {
    const h = host();
    await runRustAnalyzerScip(options(), h.deps);
    expect(configWritten(h)).toBeUndefined();
    expect([...h.texts.keys()].some((key) => key.startsWith("/tmp/ra-"))).toBe(false);
  });

  it("enables build scripts and proc macros with a target dir under the data dir when exec is on", async () => {
    const h = host();
    const config = captureConfig(h);
    await runRustAnalyzerScip(options({ exec: true }), h.deps);
    expect(config.value).toEqual(RUST_ANALYZER_EXEC_SETTINGS);
    const targetDir = h.spawns[0]?.env.CARGO_TARGET_DIR ?? "";
    expect(targetDir.startsWith(`${DATA}/rust-analyzer/target/`)).toBe(true);
  });

  it("pins RUSTC and RUSTUP_TOOLCHAIN to the project channel when rustup has it installed", async () => {
    const h = host({
      files: { [`${ROOT}/Cargo.lock`]: "lock", [`${ROOT}/rust-toolchain.toml`]: '[toolchain]\nchannel = "1.94.0"\n' },
      rustupRustc: { "1.94.0": "/home/u/.rustup/toolchains/1.94.0/bin/rustc" },
    });
    await runRustAnalyzerScip(options(), h.deps);
    expect(h.spawns[0]?.env.RUSTC).toBe("/home/u/.rustup/toolchains/1.94.0/bin/rustc");
    expect(h.spawns[0]?.env.RUSTUP_TOOLCHAIN).toBe("1.94.0");
    expect(h.commands).toContainEqual({ command: "/home/u/.rustup/toolchains/1.94.0/bin/rustc", args: ["-vV"] });
  });

  it("leaves the environment's rustc when the pinned channel is not installed", async () => {
    const h = host({
      files: { [`${ROOT}/Cargo.lock`]: "lock", [`${ROOT}/rust-toolchain`]: "nightly-2026-01-01\n" },
    });
    await runRustAnalyzerScip(options(), h.deps);
    expect(h.spawns[0]?.env.RUSTC).toBeUndefined();
    expect(h.spawns[0]?.env.RUSTUP_TOOLCHAIN).toBeUndefined();
    expect(h.commands).toContainEqual({ command: "rustc", args: ["-vV"] });
  });
});

describe("runRustAnalyzerScip — budgets", () => {
  it("kills the tree and latches on a wall-clock breach", async () => {
    const h = host({ scripts: [{ hang: true }] });
    const running = runRustAnalyzerScip(options({ timeoutSec: 10 }), h.deps);
    h.advance(5_000);
    expect(h.kills).toEqual([]);
    h.advance(6_000);
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "latched", reason: "timeout" });
    expect(h.kills).toHaveLength(1);
  });

  it("kills the tree and latches when the process tree's RSS passes the budget", async () => {
    const h = host({ scripts: [{ hang: true }], rssKb: 5 * 1024 * 1024 });
    const running = runRustAnalyzerScip(options({ maxRssMb: 4096 }), h.deps);
    h.advance(2_000);
    const outcome = await running;
    expect(outcome).toMatchObject({ kind: "latched", reason: "rss" });
    expect(h.kills).toHaveLength(1);
  });

  it("does not persist a budget latch — the next run tries again", async () => {
    const h = host({ scripts: [{ hang: true }] });
    const running = runRustAnalyzerScip(options({ timeoutSec: 1 }), h.deps);
    h.advance(2_000);
    await running;
    const second = await runRustAnalyzerScip(options(), h.deps);
    expect(second.kind).toBe("indexed");
    expect(h.spawns).toHaveLength(2);
  });
});

describe("runRustAnalyzerScip — failures never throw", () => {
  it("latches offline with a cargo fetch hint when cargo needs the network", async () => {
    const h = host({
      scripts: [
        {
          exitCode: 101,
          log: "error: failed to load cargo metadata\nattempting to make an HTTP request, but --offline was specified\n",
        },
      ],
    });
    const outcome = await runRustAnalyzerScip(options(), h.deps);
    expect(outcome).toMatchObject({ kind: "latched", reason: "offline" });
    if (outcome.kind !== "latched") throw new Error("unreachable");
    expect(outcome.hint).toBe(`cargo fetch --manifest-path ${ROOT}/Cargo.toml`);
  });

  it("latches exit on a non-zero exit with no recognised cause", async () => {
    const h = host({ scripts: [{ exitCode: 1, log: "boom" }] });
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "latched", reason: "exit" });
  });

  it("latches exit when spawn itself throws", async () => {
    const h = host({ scripts: [{ throws: true }] });
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "latched", reason: "exit" });
  });

  it("latches exit when the output is not a SCIP index", async () => {
    const h = host({ scripts: [{ exitCode: 0, output: Uint8Array.from([0x0f]) }] });
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "latched", reason: "exit" });
  });

  it("uses the output but flags toolchainSkew when rust-analyzer reports an outdated toolchain", async () => {
    const h = host({
      scripts: [
        {
          exitCode: 0,
          output: MINI_SCIP,
          log: "is using an outdated toolchain version `1.88.0` but rust-analyzer only supports `1.94.0` and higher",
        },
      ],
    });
    const outcome = await runRustAnalyzerScip(options(), h.deps);
    expect(outcome).toMatchObject({ kind: "indexed", toolchainSkew: true });
  });

  it("latches toolchainSkew when the skew left no output", async () => {
    const h = host({ scripts: [{ exitCode: 1, log: "rust-analyzer only supports `1.94.0` and higher" }] });
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "latched", reason: "toolchainSkew" });
  });
});

describe("runRustAnalyzerScip — cache and env latch", () => {
  it("answers from the decoded cache without spawning on an unchanged tree", async () => {
    const h = host();
    const first = await runRustAnalyzerScip(options(), h.deps);
    const second = await runRustAnalyzerScip(options(), h.deps);
    expect(h.spawns).toHaveLength(1);
    expect(first).toMatchObject({ kind: "indexed", cacheHit: false });
    expect(second).toMatchObject({ kind: "indexed", cacheHit: true });
    if (first.kind !== "indexed" || second.kind !== "indexed") throw new Error("unreachable");
    expect(second.index.definitionAt("src/main.rs", 7, 12)).toEqual(first.index.definitionAt("src/main.rs", 7, 12));
    expect(second.index.identity).toBe(first.index.identity);
    const cached = [...h.texts.keys()].filter((key) => key.startsWith(`${DATA}/rust-analyzer/scip/`));
    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatch(/\/scip\/[0-9a-f]{64}\/[0-9a-f]{64}\.json$/);
  });

  it("re-runs when a .rs file changes", async () => {
    const h = host();
    await runRustAnalyzerScip(options(), h.deps);
    h.sources[0] = { relPath: "src/main.rs", size: 10, mtimeMs: 2 };
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "indexed", cacheHit: false });
    expect(h.spawns).toHaveLength(2);
  });

  it("keys the cache on the exec flag", async () => {
    const h = host();
    await runRustAnalyzerScip(options(), h.deps);
    await runRustAnalyzerScip(options({ exec: true }), h.deps);
    expect(h.spawns).toHaveLength(2);
  });

  it("persists an env latch that a content change does not clear but an env change does", async () => {
    const h = host({ scripts: [{ exitCode: 101, log: "--offline was specified" }] });
    await runRustAnalyzerScip(options(), h.deps);
    h.sources[0] = { relPath: "src/main.rs", size: 11, mtimeMs: 3 };
    const blocked = await runRustAnalyzerScip(options(), h.deps);
    expect(blocked).toMatchObject({ kind: "latched", reason: "offline" });
    expect(h.spawns).toHaveLength(1);

    h.texts.set(`${ROOT}/Cargo.lock`, "lock-v2");
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "indexed" });
    expect(h.spawns).toHaveLength(2);
  });

  it("treats an unreadable cache file as a miss", async () => {
    const h = host();
    await runRustAnalyzerScip(options(), h.deps);
    for (const key of h.texts.keys()) if (key.startsWith(`${DATA}/rust-analyzer/scip/`)) h.texts.set(key, "{not json");
    expect(await runRustAnalyzerScip(options(), h.deps)).toMatchObject({ kind: "indexed", cacheHit: false });
    expect(h.spawns).toHaveLength(2);
  });
});
