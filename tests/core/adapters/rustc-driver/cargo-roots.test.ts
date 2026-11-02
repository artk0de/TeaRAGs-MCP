import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { SupervisedChild } from "../../../../src/core/adapters/process-tree/supervised-child.js";
import {
  acquireRustcCallSites,
  type RustcCallSiteRunnerDeps,
} from "../../../../src/core/adapters/rustc-driver/callsite-runner.js";
import { findCargoRoots } from "../../../../src/core/adapters/rustc-driver/cargo-roots.js";

const ROOT = "/ws";

const manifestsOf =
  (files: Record<string, string>) =>
  (path: string): string =>
    files[path] ?? "";

describe("findCargoRoots", () => {
  it("answers the repository root for a root workspace", () => {
    const files = {
      [`${ROOT}/Cargo.toml`]: '[workspace]\nmembers = ["crates/*"]\n',
      [`${ROOT}/crates/a/Cargo.toml`]: '[package]\nname = "a"\n',
    };
    expect(findCargoRoots(ROOT, ["Cargo.toml", "crates/a/Cargo.toml"], manifestsOf(files))).toEqual([ROOT]);
  });

  it("answers the package directory when only a nested backend/Cargo.toml exists", () => {
    const files = { [`${ROOT}/backend/Cargo.toml`]: '[package]\nname = "backend"\n' };
    expect(findCargoRoots(ROOT, ["backend/Cargo.toml"], manifestsOf(files))).toEqual([`${ROOT}/backend`]);
  });

  it("adds a package that no workspace's members cover", () => {
    const files = {
      [`${ROOT}/Cargo.toml`]: '[workspace]\nmembers = [\n  "crates/*",\n]\n\n[workspace.dependencies]\nserde = "1"\n',
      [`${ROOT}/crates/a/Cargo.toml`]: '[package]\nname = "a"\n',
      [`${ROOT}/tools/x/Cargo.toml`]: '[package]\nname = "x"\n',
    };
    expect(
      findCargoRoots(ROOT, ["Cargo.toml", "crates/a/Cargo.toml", "tools/x/Cargo.toml"], manifestsOf(files)),
    ).toEqual([ROOT, `${ROOT}/tools/x`]);
  });

  it("never makes a vendored or build-output crate a root", () => {
    const files = {
      [`${ROOT}/backend/Cargo.toml`]: '[package]\nname = "backend"\n',
      [`${ROOT}/backend/vendor/serde/Cargo.toml`]: '[package]\nname = "serde"\n',
      [`${ROOT}/target/package/x/Cargo.toml`]: '[package]\nname = "x"\n',
    };
    expect(
      findCargoRoots(
        ROOT,
        Object.keys(files).map((path) => path.slice(ROOT.length + 1)),
        manifestsOf(files),
      ),
    ).toEqual([`${ROOT}/backend`]);
  });

  it("answers the repository root when there is no manifest at all", () => {
    expect(findCargoRoots(ROOT, [], manifestsOf({}))).toEqual([ROOT]);
  });
});

const PIN = "nightly-2026-05-01";
const BANNER = `0.1.0 ${PIN} h1`;
const DRIVER = "/bin/tea-rags-rustc-driver";

const siteRow = (relPath: string, defRelPath: string): string =>
  JSON.stringify({
    relPath,
    line: 3,
    col: 4,
    origin: "source",
    macro: null,
    callKind: "path",
    callee: "x::helper",
    calleeCrate: "x",
    defKind: "fn",
    traitPath: null,
    implSelfType: null,
    resolvedImpl: null,
    implIsDerived: false,
    inProject: true,
    defRelPath,
    defLine: 9,
  });

interface SpawnCall {
  cwd?: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** A host whose driver writes one unit per run, its row chosen by the run's cwd. */
function rootsHost(manifests: Record<string, string>, rowsByCwd: Record<string, string>) {
  const texts = new Map<string, string>(Object.entries(manifests));
  const spawns: SpawnCall[] = [];
  let mtime = 1;
  const deps: RustcCallSiteRunnerDeps = {
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    dataDir: "/data",
    pin: PIN,
    cpuCount: 8,
    discover: () => ({ kind: "binary", tier: "path", path: DRIVER, version: "0.1.0", pin: PIN, sourceHash: "h1" }),
    buildDriver: async () => {
      throw new Error("a discovered binary is never built");
    },
    run: (command, args) => {
      if (command === "rustup") return { kind: "ok", stdout: "/tc/bin/rustc\n" };
      if (args[0] === "-vV") return { kind: "ok", stdout: "rustc 1.97.0-nightly\n" };
      if (args[0] === "-V") return { kind: "ok", stdout: `${BANNER}\n` };
      return { kind: "failed" };
    },
    spawn: (_command, _args, options): SupervisedChild => {
      spawns.push({ cwd: options.cwd, env: options.env });
      const out = options.env.TEA_RAGS_RUSTC_DRIVER_OUT ?? "";
      const unit = `${out}/units/u.ndjson`;
      texts.set(unit, rowsByCwd[options.cwd ?? ""] ?? "");
      texts.set(
        `${out}/run.json`,
        JSON.stringify({
          format: 1,
          banner: BANNER,
          success: true,
          exitCode: 0,
          units: [{ file: "u.ndjson", unit: "u", crate: "x" }],
          missing: [],
          failed: [],
          deleted: [],
        }),
      );
      mtime += 1;
      return {
        pid: 900 + spawns.length,
        exited: Promise.resolve({ code: 0, signal: null }),
        killTree: () => undefined,
      };
    },
    sampleTreeRssKb: () => 100_000,
    clock: { now: () => 0, every: () => () => undefined },
    fs: {
      readText: (path) => texts.get(path),
      writeTextAtomic: (path, text) => {
        texts.set(path, text);
      },
      remove: (path) => {
        for (const key of [...texts.keys()]) if (key === path || key.startsWith(`${path}/`)) texts.delete(key);
      },
      listDir: () => [],
      rename: () => undefined,
      removeInBackground: () => undefined,
      stat: (path) => (texts.has(path) ? { size: texts.get(path)?.length ?? 0, mtimeMs: mtime } : undefined),
      listRustSources: () => [],
      realPath: (path) => path,
    },
    lockRunRecord: async () => () => undefined,
    readCargoManifests: (projectRoot) =>
      [...texts.entries()]
        .filter(([path]) => path.startsWith(`${projectRoot}/`) && path.endsWith("/Cargo.toml"))
        .map(([path, content]) => {
          const relDir = path.slice(projectRoot.length + 1, -"/Cargo.toml".length);
          return { relDir, fileName: "Cargo.toml", content };
        }),
  };
  return { deps, spawns };
}

describe("acquireRustcCallSites — one driver run per cargo root", () => {
  it("runs cargo check in each root and merges their call sites under project-relative paths", async () => {
    const h = rootsHost(
      {
        [`${ROOT}/Cargo.toml`]: '[workspace]\nmembers = ["crates/*"]\n',
        [`${ROOT}/crates/a/Cargo.toml`]: '[package]\nname = "a"\n',
        [`${ROOT}/tools/x/Cargo.toml`]: '[package]\nname = "x"\n',
      },
      {
        [ROOT]: siteRow("crates/a/src/lib.rs", "crates/a/src/util.rs"),
        [join(ROOT, "tools/x")]: siteRow("src/main.rs", "src/helper.rs"),
      },
    );

    const result = await acquireRustcCallSites(h.deps, { projectRoot: ROOT });

    expect(h.spawns.map((spawn) => spawn.cwd)).toEqual([ROOT, `${ROOT}/tools/x`]);
    expect(new Set(h.spawns.map((spawn) => spawn.env.TEA_RAGS_RUSTC_DRIVER_OUT)).size).toBe(2);
    expect(result.status).toBe("ok");
    expect(result.diagnostics.ranCargoCheck).toBe(true);
    expect(result.diagnostics.unitCount).toBe(2);
    expect(result.index?.definitionAt("crates/a/src/lib.rs", 3, 4)?.relPath).toBe("crates/a/src/util.rs");
    expect(result.index?.definitionAt("tools/x/src/main.rs", 3, 4)?.relPath).toBe("tools/x/src/helper.rs");
    expect(result.index?.definitionAt("src/main.rs", 3, 4)).toBeNull();
  });

  it("checks only backend/ when the Rust code has no root manifest", async () => {
    const h = rootsHost(
      { [`${ROOT}/backend/Cargo.toml`]: '[package]\nname = "backend"\n' },
      { [join(ROOT, "backend")]: siteRow("src/main.rs", "src/helper.rs") },
    );

    const result = await acquireRustcCallSites(h.deps, { projectRoot: ROOT });

    expect(h.spawns.map((spawn) => spawn.cwd)).toEqual([`${ROOT}/backend`]);
    expect(result.status).toBe("ok");
    expect(result.index?.definitionAt("backend/src/main.rs", 3, 4)?.relPath).toBe("backend/src/helper.rs");
  });
});
