import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { RustSourceStamp } from "../../../../src/core/adapters/filesystem/rust-sources.js";
import type { SupervisedChild } from "../../../../src/core/adapters/process-tree/supervised-child.js";
import {
  acquireRustcCallSites,
  defaultRustcCallSiteRunnerDeps,
  type RustcCallSiteRunnerDeps,
} from "../../../../src/core/adapters/rustc-driver/callsite-runner.js";
import type { RustcDriverBuildResult } from "../../../../src/core/adapters/rustc-driver/driver-build.js";
import {
  rustcDriverInstallHint,
  type RustcDriverCommandOutcome,
  type RustcDriverDiscovery,
} from "../../../../src/core/adapters/rustc-driver/executable.js";
import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "../../../../src/core/adapters/rustc-driver/pin.js";
import type { RustCallSiteAdmission } from "../../../../src/core/contracts/types/language.js";

const PIN = "nightly-2026-05-01";
const HASH = "h1";
const DATA = "/data";
const ROOT = "/ws";
const SYSROOT = "/tc/nightly-2026-05-01-aarch64-apple-darwin";
const DRIVER = "/bin/tea-rags-rustc-driver";
const BANNER = `0.1.0 ${PIN} ${HASH}`;

const binary: RustcDriverDiscovery = {
  kind: "binary",
  tier: "path",
  path: DRIVER,
  version: "0.1.0",
  pin: PIN,
  sourceHash: HASH,
};

const row = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    relPath: "app/src/main.rs",
    line: 21,
    col: 19,
    origin: "source",
    macro: null,
    callKind: "path",
    callee: "fx_core::Store::get",
    calleeCrate: "fx_core",
    defKind: "assocFn",
    traitPath: "fx_core::Store",
    implSelfType: null,
    resolvedImpl: null,
    implIsDerived: false,
    inProject: true,
    defRelPath: "core/src/lib.rs",
    defLine: 24,
    ...over,
  });

interface DriverScript {
  /** run.json written into TEA_RAGS_RUSTC_DRIVER_OUT; absent = none written. */
  runJson?: Record<string, unknown>;
  /** unit file name → NDJSON text, written under `<out>/units/`. */
  units?: Record<string, string>;
  exitCode?: number;
  /** Text the child writes to its output (cargo stderr) before it exits. */
  output?: string;
  /** Never exits on its own: only a kill settles it. */
  hang?: boolean;
}

const okRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  banner: BANNER,
  success: true,
  exitCode: 0,
  units: [
    { file: "app-1.ndjson", unit: "app-1", crate: "app" },
    { file: "fx_core-2.ndjson", unit: "fx_core-2", crate: "fx_core" },
  ],
  missing: [],
  failed: [],
  deleted: [],
  ...over,
});

const okScript = (over: Partial<DriverScript> = {}): DriverScript => ({
  runJson: okRun(),
  units: { "app-1.ndjson": row(), "fx_core-2.ndjson": "" },
  exitCode: 0,
  ...over,
});

interface SpawnCall {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}

function host(
  init: {
    env?: Record<string, string | undefined>;
    discovery?: RustcDriverDiscovery | null;
    build?: RustcDriverBuildResult;
    scripts?: DriverScript[];
    files?: Record<string, string>;
    rustcVV?: string;
    cpuCount?: number;
    sources?: RustSourceStamp[];
  } = {},
) {
  let sources = init.sources ?? [
    { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
    { relPath: "core/src/lib.rs", size: 200, mtimeMs: 1 },
  ];
  let listings = 0;
  const texts = new Map<string, string>(
    Object.entries(init.files ?? { [`${ROOT}/Cargo.lock`]: "lock-v1", [`${ROOT}/README.md`]: "readme" }),
  );
  const stamps = new Map<string, { size: number; mtimeMs: number }>();
  const spawns: SpawnCall[] = [];
  const removed: string[] = [];
  const written: string[] = [];
  const kills: number[] = [];
  const scripts = [...(init.scripts ?? [okScript()])];
  let discoverCalls = 0;
  let builds = 0;
  let now = 0;
  let tick: (() => void) | undefined;
  let mtime = 1;

  const deps: RustcCallSiteRunnerDeps = {
    env: { PATH: "/usr/bin", HOME: "/home/u", ...(init.env ?? {}) },
    dataDir: DATA,
    pin: PIN,
    cpuCount: init.cpuCount ?? 8,
    discover: () => {
      discoverCalls += 1;
      return init.discovery === undefined ? binary : init.discovery;
    },
    buildDriver: async () => {
      builds += 1;
      return (
        init.build ?? {
          ok: true,
          built: true,
          binDir: "/data/rustc-driver/bin/x",
          binaryPath: "/data/rustc-driver/bin/x/tea-rags-rustc-driver",
          wrapperPath: "/data/rustc-driver/bin/x/tea-rags-rustc-driver-wrapper",
        }
      );
    },
    run: (command, args): RustcDriverCommandOutcome => {
      if (command === "rustup" && args[0] === "which") return { kind: "ok", stdout: `${SYSROOT}/bin/rustc\n` };
      if (args[0] === "-vV") return { kind: "ok", stdout: init.rustcVV ?? `rustc 1.97.0-nightly (via ${command})\n` };
      if (args[0] === "-V") return { kind: "ok", stdout: `${BANNER}\n` };
      return { kind: "failed" };
    },
    spawn: (command, args, options): SupervisedChild => {
      spawns.push({ command, args, env: options.env, cwd: options.cwd });
      const script = scripts.shift() ?? okScript();
      const out = options.env.TEA_RAGS_RUSTC_DRIVER_OUT ?? "";
      for (const [name, text] of Object.entries(script.units ?? {})) {
        texts.set(`${out}/units/${name}`, text);
        stamps.set(`${out}/units/${name}`, { size: text.length, mtimeMs: mtime++ });
      }
      if (script.runJson) texts.set(`${out}/run.json`, JSON.stringify(script.runJson));
      if (script.output) options.onOutput(script.output);
      let resolveExit: (exit: { code: number | null; signal: string | null }) => void = () => undefined;
      const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
        resolveExit = done;
      });
      const pid = 900 + spawns.length;
      if (!script.hang) resolveExit({ code: script.exitCode ?? 0, signal: null });
      return {
        pid,
        exited,
        killTree: () => {
          kills.push(pid);
          resolveExit({ code: null, signal: "SIGKILL" });
        },
      };
    },
    sampleTreeRssKb: () => 100_000,
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
      readText: (path) => texts.get(path),
      writeTextAtomic: (path, text) => {
        written.push(path);
        texts.set(path, text);
      },
      remove: (path) => {
        removed.push(path);
        for (const key of [...texts.keys()]) if (key === path || key.startsWith(`${path}/`)) texts.delete(key);
      },
      stat: (path) => stamps.get(path),
      listRustSources: () => {
        listings += 1;
        return sources;
      },
      realPath: (path) => path,
    },
    readCargoManifests: () =>
      [...texts.entries()]
        .filter(([path]) => path.endsWith("Cargo.toml"))
        .map(([path, content]) => ({
          relDir: dirname(path.slice(ROOT.length + 1)),
          fileName: "Cargo.toml",
          content,
        })),
  };
  return {
    deps,
    texts,
    stamps,
    spawns,
    removed,
    written,
    kills,
    discoverCalls: () => discoverCalls,
    builds: () => builds,
    listings: () => listings,
    setSources: (next: RustSourceStamp[]) => {
      sources = next;
    },
    /** Advance the clock and fire the budget poll. */
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
  };
}

const acquire = async (
  h: ReturnType<typeof host>,
  options: { cargoArgs?: string; timeoutSec?: number; admission?: RustCallSiteAdmission } = {},
) => acquireRustcCallSites(h.deps, { projectRoot: ROOT, ...options });

const envKeyOf = (spawn: SpawnCall | undefined): string => {
  const out = spawn?.env.TEA_RAGS_RUSTC_DRIVER_OUT ?? "";
  return out.slice(`${DATA}/rustc-driver/`.length);
};

const flush = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 0));
};

describe("acquireRustcCallSites — gating", () => {
  it("CODEGRAPH_RUST_DRIVER=off answers disabled and spawns nothing", async () => {
    const h = host({ env: { CODEGRAPH_RUST_DRIVER: "off" } });
    const result = await acquire(h);
    expect(result.status).toBe("disabled");
    expect(result.index).toBeUndefined();
    expect(result.diagnostics.ranCargoCheck).toBe(false);
    expect(h.discoverCalls()).toBe(0);
    expect(h.spawns).toHaveLength(0);
  });

  it("no driver and no buildable toolchain answers unavailable with the install hint", async () => {
    const h = host({ discovery: null });
    const result = await acquire(h);
    expect(result.status).toBe("unavailable");
    expect(result.diagnostics.hint).toBe(rustcDriverInstallHint(PIN));
    expect(result.diagnostics.ranCargoCheck).toBe(false);
    expect(h.spawns).toHaveLength(0);
  });
});

describe("acquireRustcCallSites — child environment", () => {
  it("forces the pin's toolchain and the data-dir target and output dirs", async () => {
    const h = host({ env: { RUSTC_WRAPPER: "sccache", RUSTC_WORKSPACE_WRAPPER: "clippy-driver" } });
    await acquire(h);
    const spawn = h.spawns[0];
    const envKey = envKeyOf(spawn);
    expect(envKey).toMatch(/^[0-9a-f]{64}$/);
    expect(spawn?.command).toBe(DRIVER);
    expect(spawn?.cwd).toBe(ROOT);
    expect(spawn?.env).toMatchObject({
      RUSTUP_TOOLCHAIN: PIN,
      RUSTC: `${SYSROOT}/bin/rustc`,
      SYSROOT,
      PATH: `${SYSROOT}/bin:/usr/bin`,
      CARGO_TARGET_DIR: `${DATA}/rustc-driver/${envKey}/target`,
      TEA_RAGS_RUSTC_DRIVER_OUT: `${DATA}/rustc-driver/${envKey}`,
      TEA_RAGS_RUSTC_DRIVER_CARGO_ARGS: "--workspace --all-targets",
      CARGO_NET_OFFLINE: "true",
      CMAKE_POLICY_VERSION_MINIMUM: "3.5",
      CARGO_BUILD_JOBS: "4",
    });
    expect(spawn?.env.RUSTC_WRAPPER).toBeUndefined();
    expect(spawn?.env.RUSTC_WORKSPACE_WRAPPER).toBeUndefined();
  });

  it("takes -j from CODEGRAPH_RUST_DRIVER_JOBS, else half the cores and at least one", async () => {
    const explicit = host({ env: { CODEGRAPH_RUST_DRIVER_JOBS: "3" } });
    await acquire(explicit);
    expect(explicit.spawns[0]?.env.CARGO_BUILD_JOBS).toBe("3");

    const single = host({ cpuCount: 1 });
    await acquire(single);
    expect(single.spawns[0]?.env.CARGO_BUILD_JOBS).toBe("1");
  });

  it("never references the user's target/ directory", async () => {
    const h = host({ env: { CARGO_TARGET_DIR: `${ROOT}/target`, CARGO_BUILD_TARGET_DIR: `${ROOT}/target` } });
    await acquire(h);
    const values = Object.values(h.spawns[0]?.env ?? {});
    expect(values.some((value) => value?.includes(`${ROOT}/target`))).toBe(false);
    expect([...h.removed, ...h.written].some((path) => path.startsWith(`${ROOT}/target`))).toBe(false);
  });

  it("builds a buildable driver first and runs the built binary", async () => {
    const buildable: RustcDriverDiscovery = {
      kind: "buildable",
      tier: "rustup",
      sysroot: SYSROOT,
      host: "aarch64-apple-darwin",
    };
    const h = host({ discovery: buildable });
    const result = await acquire(h);
    expect(h.builds()).toBe(1);
    expect(h.spawns[0]?.command).toBe("/data/rustc-driver/bin/x/tea-rags-rustc-driver");
    expect(h.spawns[0]?.env.SYSROOT).toBe(SYSROOT);
    expect(result.status).toBe("ok");
  });
});

describe("acquireRustcCallSites — envKey", () => {
  const keyFor = async (init: Parameters<typeof host>[0], cargoArgs?: string): Promise<string> => {
    const h = host(init);
    await acquire(h, cargoArgs ? { cargoArgs } : {});
    return envKeyOf(h.spawns[0]);
  };
  const files = (over: Record<string, string> = {}): Record<string, string> => ({
    [`${ROOT}/Cargo.lock`]: "lock-v1",
    [`${ROOT}/Cargo.toml`]: "[workspace]",
    [`${ROOT}/core/Cargo.toml`]: "[package] core",
    [`${ROOT}/README.md`]: "readme",
    ...over,
  });

  it("changes with Cargo.lock, a Cargo.toml, the pin's rustc and the cargo args", async () => {
    const base = await keyFor({ files: files() });
    expect(await keyFor({ files: files() })).toBe(base);
    expect(await keyFor({ files: files({ [`${ROOT}/Cargo.lock`]: "lock-v2" }) })).not.toBe(base);
    expect(await keyFor({ files: files({ [`${ROOT}/core/Cargo.toml`]: "[package] core2" }) })).not.toBe(base);
    expect(await keyFor({ files: files(), rustcVV: "rustc 1.98.0-nightly\n" })).not.toBe(base);
    expect(await keyFor({ files: files() }, "--workspace")).not.toBe(base);
  });

  it("does not change with an unrelated file or with -j", async () => {
    const base = await keyFor({ files: files() });
    expect(await keyFor({ files: files({ [`${ROOT}/README.md`]: "edited" }) })).toBe(base);
    expect(await keyFor({ files: files(), env: { CODEGRAPH_RUST_DRIVER_JOBS: "7" } })).toBe(base);
  });
});

describe("acquireRustcCallSites — outcome and latch lattice", () => {
  it("decodes the listed units into a definitionAt index and reports the run", async () => {
    const h = host();
    const result = await acquire(h);
    expect(result.status).toBe("ok");
    expect(result.index?.definitionAt("app/src/main.rs", 21, 19)).toMatchObject({
      relPath: "core/src/lib.rs",
      line: 24,
      inProject: true,
    });
    expect(result.diagnostics).toMatchObject({ ranCargoCheck: true, unitCount: 2, failedCrates: [] });
    expect(result.diagnostics.wallMs).toEqual(expect.any(Number));
    expect(result.index?.identity.startsWith(envKeyOf(h.spawns[0]))).toBe(true);
  });

  it("changes identity when a unit file changes", async () => {
    const h = host({
      scripts: [okScript(), okScript({ units: { "app-1.ndjson": `${row()}\n${row({ line: 30 })}` } })],
    });
    const first = await acquire(h);
    const second = await acquire(h);
    expect(first.index?.identity).not.toBe(second.index?.identity);
  });

  it("surfaces per-crate compile failures without latching", async () => {
    const failed = [
      { packageId: "path+file:///ws/app#0.1.0", target: "app", kind: ["bin"], firstError: "cannot find value `x`" },
    ];
    const h = host({
      scripts: [okScript({ runJson: okRun({ success: false, exitCode: 101, failed }), exitCode: 101 }), okScript()],
    });
    const result = await acquire(h);
    expect(result.status).toBe("partial");
    expect(result.diagnostics.failedCrates).toEqual([
      { packageId: "path+file:///ws/app#0.1.0", target: "app", firstError: "cannot find value `x`" },
    ]);
    expect(result.diagnostics.latched).toBeUndefined();
    await acquire(h);
    expect(h.spawns).toHaveLength(2);
  });

  it("names the package of a failure cargo reported only on stderr (a build script that failed to run)", async () => {
    const failed = [
      {
        package: "servo-capi-tests",
        target: "build-script-build",
        kind: ["custom-build"],
        test: false,
        firstError: "failed to run custom build command for `servo-capi-tests v0.0.1 (/ws/capi)`",
      },
    ];
    const h = host({
      scripts: [okScript({ runJson: okRun({ success: false, exitCode: 101, failed }), exitCode: 101 })],
    });
    const result = await acquire(h);
    expect(result.status).toBe("partial");
    expect(result.diagnostics.failedCrates).toEqual([
      {
        packageId: "servo-capi-tests",
        target: "build-script-build",
        firstError: "failed to run custom build command for `servo-capi-tests v0.0.1 (/ws/capi)`",
      },
    ]);
  });

  it("latches an environment failure (every unit failed) per envKey and stops spawning", async () => {
    const failed = [{ packageId: "p", target: "app", kind: ["bin"], firstError: "E0514 incompatible rustc" }];
    const h = host({
      scripts: [
        okScript({ runJson: okRun({ success: false, exitCode: 101, units: [], failed }), units: {}, exitCode: 101 }),
      ],
    });
    const result = await acquire(h);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.latched?.reason).toBe("allUnitsFailed");
    const again = await acquire(h);
    expect(again.status).toBe("failed");
    expect(again.diagnostics.latched?.reason).toBe("allUnitsFailed");
    expect(again.diagnostics.ranCargoCheck).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });

  const allFailedScript = (): DriverScript =>
    okScript({
      runJson: okRun({
        success: false,
        exitCode: 101,
        units: [],
        failed: [{ packageId: "p", target: "app", kind: ["lib"], firstError: "E0308 mismatched types" }],
      }),
      units: {},
      exitCode: 101,
    });

  it("keeps an allUnitsFailed latch while the Rust sources are unchanged", async () => {
    const h = host({ scripts: [allFailedScript()] });
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
      { relPath: "core/src/lib.rs", size: 200, mtimeMs: 1 },
    ]);
    const again = await acquire(h);
    expect(again.status).toBe("failed");
    expect(again.diagnostics.latched?.reason).toBe("allUnitsFailed");
    expect(again.diagnostics.ranCargoCheck).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });

  const OFFLINE_STDERR =
    "error: failed to get `dep` as a dependency\n\nCaused by:\n  attempting to make an HTTP request, but --offline was specified\n";
  const allFailedWith = (output: string): DriverScript => ({ ...allFailedScript(), output });

  it("does not latch an all-failed run whose cargo stderr is the offline-fetch failure, and keeps the cargo fetch hint", async () => {
    const h = host({ scripts: [allFailedWith(OFFLINE_STDERR)] });
    const result = await acquire(h);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.hint).toMatch(/^cargo fetch --manifest-path /);
    expect(h.texts.has(`${DATA}/rustc-driver/${envKeyOf(h.spawns[0])}/latch.json`)).toBe(false);
  });

  it("spawns cargo again on the next acquire after an offline-fetch failure with unchanged sources", async () => {
    const h = host({ scripts: [allFailedWith(OFFLINE_STDERR), allFailedWith(OFFLINE_STDERR)] });
    await acquire(h);
    const again = await acquire(h);
    expect(again.diagnostics.ranCargoCheck).toBe(true);
    expect(again.diagnostics.hint).toMatch(/^cargo fetch/);
    expect(h.spawns).toHaveLength(2);
  });

  it("still latches an all-failed run with a type-error stderr and does not respawn", async () => {
    const h = host({ scripts: [allFailedWith("error[E0308]: mismatched types\n")] });
    const result = await acquire(h);
    expect(result.diagnostics.latched?.reason).toBe("allUnitsFailed");
    expect(h.texts.has(`${DATA}/rustc-driver/${envKeyOf(h.spawns[0])}/latch.json`)).toBe(true);
    const again = await acquire(h);
    expect(again.diagnostics.ranCargoCheck).toBe(false);
    expect(h.spawns).toHaveLength(1);
  });

  it("re-runs cargo once a Rust source's size or mtime changed under an allUnitsFailed latch", async () => {
    const h = host({ scripts: [allFailedScript(), allFailedScript()] });
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
      { relPath: "core/src/lib.rs", size: 200, mtimeMs: 7 },
    ]);
    const afterTouch = await acquire(h);
    expect(afterTouch.diagnostics.ranCargoCheck).toBe(true);
    expect(h.spawns).toHaveLength(2);
    h.setSources([
      { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
      { relPath: "core/src/lib.rs", size: 199, mtimeMs: 7 },
    ]);
    await acquire(h);
    expect(h.spawns).toHaveLength(3);
  });

  it("answers ok after the fixed sources compile and does not latch again", async () => {
    const h = host({ scripts: [allFailedScript(), okScript()] });
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
      { relPath: "core/src/lib.rs", size: 180, mtimeMs: 9 },
    ]);
    const fixed = await acquire(h);
    expect(fixed.status).toBe("ok");
    expect(fixed.diagnostics.latched).toBeUndefined();
    expect(h.texts.has(`${DATA}/rustc-driver/${envKeyOf(h.spawns[1])}/latch.json`)).toBe(false);
    const next = await acquire(h);
    expect(next.status).toBe("ok");
    expect(h.spawns).toHaveLength(3);
  });

  it("treats an allUnitsFailed latch written without source stamps as stale", async () => {
    const h = host();
    await acquire(h);
    const envDir = `${DATA}/rustc-driver/${envKeyOf(h.spawns[0])}`;
    h.texts.set(`${envDir}/latch.json`, JSON.stringify({ reason: "allUnitsFailed", detail: "old" }));
    const result = await acquire(h);
    expect(result.status).toBe("ok");
    expect(h.spawns).toHaveLength(2);
  });

  it("keeps a driverBuild latch regardless of source changes", async () => {
    const h = host();
    await acquire(h);
    const envDir = `${DATA}/rustc-driver/${envKeyOf(h.spawns[0])}`;
    h.texts.set(`${envDir}/latch.json`, JSON.stringify({ reason: "driverBuild", detail: "cargo build exited 101" }));
    h.setSources([{ relPath: "app/src/main.rs", size: 5, mtimeMs: 42 }]);
    const result = await acquire(h);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.latched).toMatchObject({ reason: "driverBuild" });
    expect(h.spawns).toHaveLength(1);
  });

  it("latches a failed driver build and spawns nothing", async () => {
    const buildable: RustcDriverDiscovery = {
      kind: "buildable",
      tier: "rustup",
      sysroot: SYSROOT,
      host: "aarch64-apple-darwin",
    };
    const h = host({
      discovery: buildable,
      build: { ok: false, reason: "build-failed", detail: "cargo build exited with status 101", logPath: "/data/log" },
    });
    const result = await acquire(h);
    expect(result.status).toBe("failed");
    expect(result.diagnostics.latched).toMatchObject({ reason: "driverBuild" });
    expect(h.spawns).toHaveLength(0);
  });

  it("kills the tree on a budget breach and does not latch it", async () => {
    const h = host({ scripts: [{ hang: true }, okScript()] });
    const pending = acquire(h, { timeoutSec: 60 });
    await flush();
    h.advance(61_000);
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.diagnostics.budget?.reason).toBe("timeout");
    expect(result.diagnostics.latched).toBeUndefined();
    expect(h.kills).toHaveLength(1);
    const again = await acquire(h);
    expect(again.status).toBe("ok");
    expect(h.spawns).toHaveLength(2);
  });

  it("retries once with a fresh target dir when run.json lists missing units", async () => {
    const missing = [{ unit: "app-1", packageId: "p", target: "app", kind: ["bin"], test: false }];
    const h = host({ scripts: [okScript({ runJson: okRun({ units: [], missing }), units: {} }), okScript()] });
    const result = await acquire(h);
    expect(h.spawns).toHaveLength(2);
    const envKey = envKeyOf(h.spawns[0]);
    expect(h.removed).toContain(`${DATA}/rustc-driver/${envKey}/target`);
    expect(result.status).toBe("ok");
    expect(result.diagnostics.retried).toBe(true);
  });

  it("does not retry a second time when units stay missing", async () => {
    const missing = [{ unit: "app-1", packageId: "p", target: "app", kind: ["bin"], test: false }];
    const stillMissing = okScript({ runJson: okRun({ missing }) });
    const h = host({ scripts: [stillMissing, stillMissing, okScript()] });
    const result = await acquire(h);
    expect(h.spawns).toHaveLength(2);
    expect(result.status).toBe("partial");
    expect(result.diagnostics.missingUnits).toBe(1);
  });
});

describe("acquireRustcCallSites — admission (reuseOnly never spawns cargo)", () => {
  const reuseOnly: RustCallSiteAdmission = () => "reuseOnly";

  it("asks admission with the project's .rs files and runs the driver on spawn", async () => {
    const h = host();
    const seen: (readonly string[])[] = [];
    const result = await acquire(h, {
      admission: (paths) => {
        seen.push(paths);
        return "spawn";
      },
    });
    expect(seen).toEqual([["app/src/main.rs", "core/src/lib.rs"]]);
    expect(h.spawns).toHaveLength(1);
    expect(result.status).toBe("ok");
  });

  it("answers noCache without spawning or building when no earlier run exists", async () => {
    const h = host();
    const result = await acquire(h, { admission: reuseOnly });
    expect(result.status).toBe("noCache");
    expect(h.spawns).toHaveLength(0);
    expect(result.index).toBeUndefined();
  });

  it("never builds a buildable driver under reuseOnly", async () => {
    const h = host({
      discovery: { kind: "buildable", tier: "rustup", sysroot: SYSROOT, host: "aarch64-apple-darwin" },
    });
    const result = await acquire(h, { admission: reuseOnly });
    expect(result.status).toBe("noCache");
    expect(h.builds()).toBe(0);
    expect(h.spawns).toHaveLength(0);
  });

  it("serves the earlier run's units without spawning when no source changed", async () => {
    const h = host();
    const first = await acquire(h);
    const reused = await acquire(h, { admission: reuseOnly });
    expect(h.spawns).toHaveLength(1);
    expect(reused.status).toBe("reused");
    expect(reused.diagnostics.ranCargoCheck).toBe(false);
    expect(reused.index?.definitionAt("app/src/main.rs", 21, 19)).toMatchObject({
      relPath: "core/src/lib.rs",
      line: 24,
    });
    expect(reused.index?.identity).not.toBe(first.index?.identity);
  });

  it("answers null for a site in a changed file and for a definition located in one", async () => {
    const h = host();
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
      { relPath: "core/src/lib.rs", size: 201, mtimeMs: 2 },
    ]);
    const viaChangedDefinition = await acquire(h, { admission: reuseOnly });
    expect(viaChangedDefinition.status).toBe("reused");
    expect(viaChangedDefinition.index?.definitionAt("app/src/main.rs", 21, 19)).toBeNull();

    h.setSources([
      { relPath: "app/src/main.rs", size: 101, mtimeMs: 2 },
      { relPath: "core/src/lib.rs", size: 200, mtimeMs: 1 },
    ]);
    const inChangedFile = await acquire(h, { admission: reuseOnly });
    expect(inChangedFile.index?.definitionAt("app/src/main.rs", 21, 19)).toBeNull();
    expect(h.spawns).toHaveLength(1);
  });

  it("does not serve a run whose spawn failed afterwards", async () => {
    const h = host({ scripts: [okScript(), okScript({ runJson: undefined, exitCode: 101 })] });
    await acquire(h);
    expect((await acquire(h)).status).toBe("failed");
    expect((await acquire(h, { admission: reuseOnly })).status).toBe("noCache");
  });

  it("answers a persisted latch under reuseOnly too", async () => {
    const h = host({ scripts: [okScript({ runJson: okRun({ success: false, units: [] }), units: {} })] });
    await acquire(h);
    const result = await acquire(h, { admission: reuseOnly });
    expect(result.status).toBe("failed");
    expect(result.diagnostics.latched?.reason).toBe("allUnitsFailed");
  });

  const coreFailed = {
    packageId: "path+file:///ws/core#fx_core@0.1.0",
    target: "fx_core",
    kind: ["lib"],
    firstError: "E0308 mismatched types",
  };
  const partialScript = (failed: Record<string, unknown>[] = [coreFailed]): DriverScript =>
    okScript({
      runJson: okRun({ success: false, exitCode: 101, units: [{ file: "app-1.ndjson", crate: "app" }], failed }),
      units: { "app-1.ndjson": row() },
      exitCode: 101,
    });
  const touchedCore = [
    { relPath: "app/src/main.rs", size: 100, mtimeMs: 1 },
    { relPath: "core/src/lib.rs", size: 190, mtimeMs: 5 },
  ];

  it("re-runs cargo under reuseOnly when a source of a crate that failed last run changed", async () => {
    const h = host({ scripts: [partialScript(), okScript()] });
    expect((await acquire(h)).status).toBe("partial");
    h.setSources(touchedCore);
    const rerun = await acquire(h, { admission: reuseOnly });
    expect(h.spawns).toHaveLength(2);
    expect(rerun.status).toBe("ok");
    expect(rerun.diagnostics.ranCargoCheck).toBe(true);
  });

  it("matches a failed crate cargo names under the canonical path of a symlinked project root", async () => {
    const canonical = { ...coreFailed, packageId: "path+file:///private/ws/core#fx_core@0.1.0" };
    const h = host({ scripts: [partialScript([canonical]), okScript()] });
    h.deps.fs.realPath = (path) => (path === ROOT ? "/private/ws" : path);
    await acquire(h);
    h.setSources(touchedCore);
    await acquire(h, { admission: reuseOnly });
    expect(h.spawns).toHaveLength(2);
  });

  it("reuses a partial run under reuseOnly when no source changed", async () => {
    const h = host({ scripts: [partialScript()] });
    await acquire(h);
    const reused = await acquire(h, { admission: reuseOnly });
    expect(reused.status).toBe("reused");
    expect(h.spawns).toHaveLength(1);
  });

  it("reuses a partial run under reuseOnly when only sources outside the failed crates changed", async () => {
    const h = host({ scripts: [partialScript()] });
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 101, mtimeMs: 5 },
      { relPath: "core/src/lib.rs", size: 200, mtimeMs: 1 },
    ]);
    const reused = await acquire(h, { admission: reuseOnly });
    expect(reused.status).toBe("reused");
    expect(h.spawns).toHaveLength(1);
  });

  it("re-runs cargo under reuseOnly when a failure names no crate dir and any source changed", async () => {
    const stderrOnly = { package: "fx_core", target: "build-script-build", kind: ["custom-build"], firstError: "x" };
    const h = host({ scripts: [partialScript([stderrOnly]), okScript()] });
    await acquire(h);
    h.setSources([
      { relPath: "app/src/main.rs", size: 101, mtimeMs: 5 },
      { relPath: "core/src/lib.rs", size: 200, mtimeMs: 1 },
    ]);
    await acquire(h, { admission: reuseOnly });
    expect(h.spawns).toHaveLength(2);
  });

  it("never spawns under reuseOnly after an ok run, even when a source changed", async () => {
    const h = host();
    expect((await acquire(h)).status).toBe("ok");
    h.setSources(touchedCore);
    const reused = await acquire(h, { admission: reuseOnly });
    expect(reused.status).toBe("reused");
    expect(h.spawns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Real driver, gated on the pinned toolchain (with rustc-dev) being installed.
// ---------------------------------------------------------------------------

const CRATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../native/tea-rags-rustc-driver");
const realDeps = defaultRustcCallSiteRunnerDeps({
  ...process.env,
  TEA_RAGS_DATA_DIR: join(tmpdir(), "tea-rags-rustc-driver-it"),
});
const realDriverAvailable = process.platform !== "win32" && realDeps.discover() !== null;

describe.skipIf(!realDriverAvailable)(`acquireRustcCallSites — real driver (${RUSTC_DRIVER_TOOLCHAIN_PIN})`, () => {
  it("runs cargo check over the fixture workspace and resolves a UFCS call to its impl", async () => {
    const work = mkdtempSync(join(tmpdir(), "tea-rags-callsites-ws-"));
    try {
      // The whole fixtures tree: `deps/` holds path dependencies OUTSIDE the workspace root.
      cpSync(join(CRATE_DIR, "tests/fixtures"), work, { recursive: true });
      const result = await acquireRustcCallSites(realDeps, { projectRoot: join(work, "workspace") });
      expect(result.diagnostics.latched).toBeUndefined();
      expect(result.status).toBe("ok");
      expect(result.diagnostics.ranCargoCheck).toBe(true);
      expect(result.index?.definitionAt("app/src/main.rs", 21, 19)).toMatchObject({
        relPath: "core/src/lib.rs",
        line: 24,
        inProject: true,
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 900_000);
});
