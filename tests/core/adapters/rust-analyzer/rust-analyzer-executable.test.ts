import { describe, expect, it, vi } from "vitest";

import {
  createRustAnalyzerResolver,
  discoverRustAnalyzer,
  parseRustAnalyzerVersion,
  RUST_ANALYZER_INSTALL_HINT,
  rustAnalyzerInstallHintFor,
  type RustAnalyzerCommandOutcome,
  type RustAnalyzerDiscoveryDeps,
} from "../../../../src/core/adapters/rust-analyzer/index.js";

const HOME = "/home/u";
const BANNER = "rust-analyzer 1.85.0 (4d91de4e 2025-02-17)";

interface FakeHost {
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  links?: Record<string, string>;
  /** Binary → `--version` outcome. Absent binaries fail. */
  versions?: Record<string, RustAnalyzerCommandOutcome>;
  /** `rustup which` answer per toolchain key ("" = no --toolchain). */
  rustupWhich?: Record<string, string>;
  env?: Record<string, string | undefined>;
  projectRoot?: string;
}

function deps(host: FakeHost): RustAnalyzerDiscoveryDeps & { run: ReturnType<typeof vi.fn> } {
  const files = host.files ?? {};
  const run = vi.fn((command: string, args: readonly string[]): RustAnalyzerCommandOutcome => {
    if (command === "rustup") {
      const index = args.indexOf("--toolchain");
      const key = index >= 0 ? (args[index + 1] ?? "") : "";
      const answer = host.rustupWhich?.[key];
      return answer ? { kind: "ok", stdout: `${answer}\n` } : { kind: "failed" };
    }
    return host.versions?.[command] ?? { kind: "failed" };
  });
  return {
    env: { PATH: "/usr/bin", ...host.env },
    homeDir: HOME,
    projectRoot: host.projectRoot,
    run,
    fs: {
      exists: (p) => p in files || p in (host.versions ?? {}) || p in (host.dirs ?? {}),
      readFile: (p) => files[p],
      listDir: (p) => host.dirs?.[p] ?? [],
      realPath: (p) => host.links?.[p] ?? p,
    },
  };
}

describe("parseRustAnalyzerVersion", () => {
  it("parses the rustup component banner", () => {
    expect(parseRustAnalyzerVersion(BANNER)).toEqual({ version: "1.85.0", commit: "4d91de4e", date: "2025-02-17" });
  });

  it("parses the standalone build banner", () => {
    expect(parseRustAnalyzerVersion("rust-analyzer 0.0.0 (5ec20d044d 2026-10-18)\n")).toEqual({
      version: "0.0.0",
      commit: "5ec20d044d",
      date: "2026-10-18",
    });
  });

  it("rejects output that is not a rust-analyzer banner", () => {
    expect(parseRustAnalyzerVersion("error: Unknown binary 'rust-analyzer'")).toBeNull();
    expect(parseRustAnalyzerVersion("")).toBeNull();
  });
});

describe("discoverRustAnalyzer — tier order", () => {
  it("tier 1: CODEGRAPH_RUST_ANALYZER_PATH wins over every other tier", () => {
    const found = discoverRustAnalyzer(
      deps({
        env: { CODEGRAPH_RUST_ANALYZER_PATH: "/opt/ra/rust-analyzer", PATH: "/usr/local/bin" },
        versions: {
          "/opt/ra/rust-analyzer": { kind: "ok", stdout: BANNER },
          "/usr/local/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
        },
      }),
    );
    expect(found).toMatchObject({ path: "/opt/ra/rust-analyzer", tier: "env", version: "1.85.0", date: "2025-02-17" });
  });

  it("tier 1 reads only the exact env name — no alias spelling is honoured", () => {
    const found = discoverRustAnalyzer(
      deps({
        env: { RUST_ANALYZER_PATH: "/opt/ra/rust-analyzer", CODEGRAPH_RUST_ANALYZER: "/opt/ra/rust-analyzer" },
        versions: { "/opt/ra/rust-analyzer": { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toBeNull();
  });

  it("a tier-1 binary whose --version fails falls through to the next tier", () => {
    const found = discoverRustAnalyzer(
      deps({
        env: { CODEGRAPH_RUST_ANALYZER_PATH: "/opt/ra/broken", PATH: "/usr/local/bin" },
        versions: { "/usr/local/bin/rust-analyzer": { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: "/usr/local/bin/rust-analyzer", tier: "path" });
  });

  it("tier 2: rust-analyzer on PATH, first PATH entry first", () => {
    const found = discoverRustAnalyzer(
      deps({
        env: { PATH: "/a/bin:/b/bin" },
        versions: {
          "/a/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
          "/b/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
        },
      }),
    );
    expect(found).toMatchObject({ path: "/a/bin/rust-analyzer", tier: "path" });
  });

  it("tier 2 rejects the rustup proxy stub when `rustup which` fails", () => {
    const proxy = `${HOME}/.cargo/bin/rust-analyzer`;
    const host = deps({
      env: { PATH: `${HOME}/.cargo/bin` },
      links: { [proxy]: `${HOME}/.cargo/bin/rustup` },
      versions: { [proxy]: { kind: "ok", stdout: BANNER } },
    });
    expect(discoverRustAnalyzer(host)).toBeNull();
  });

  it("tier 2 follows the rustup proxy to the real binary when `rustup which` answers", () => {
    const proxy = `${HOME}/.cargo/bin/rust-analyzer`;
    const real = `${HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rust-analyzer`;
    const found = discoverRustAnalyzer(
      deps({
        env: { PATH: `${HOME}/.cargo/bin` },
        links: { [proxy]: `${HOME}/.cargo/bin/rustup` },
        rustupWhich: { "": real },
        versions: { [proxy]: { kind: "ok", stdout: BANNER }, [real]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: real, tier: "path" });
  });

  it("tier 3: `rustup which --toolchain <pinned channel>` from rust-toolchain.toml", () => {
    const pinned = `${HOME}/.rustup/toolchains/1.85.0-aarch64-apple-darwin/bin/rust-analyzer`;
    const found = discoverRustAnalyzer(
      deps({
        projectRoot: "/repo",
        files: { "/repo/rust-toolchain.toml": '[toolchain]\nchannel = "1.85.0"\n' },
        rustupWhich: { "1.85.0": pinned },
        versions: { [pinned]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: pinned, tier: "rustup", toolchain: "1.85.0" });
  });

  it("tier 3: the legacy rust-toolchain file pins the channel too", () => {
    const pinned = `${HOME}/.rustup/toolchains/nightly-2025-01-01-x86_64-unknown-linux-gnu/bin/rust-analyzer`;
    const found = discoverRustAnalyzer(
      deps({
        projectRoot: "/repo",
        files: { "/repo/rust-toolchain": "nightly-2025-01-01\n" },
        rustupWhich: { "nightly-2025-01-01": pinned },
        versions: { [pinned]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: pinned, tier: "rustup" });
  });

  it("tier 3: toolchain glob prefers the project-pinned channel over others", () => {
    const toolchains = `${HOME}/.rustup/toolchains`;
    const stable = `${toolchains}/stable-aarch64-apple-darwin/bin/rust-analyzer`;
    const pinned = `${toolchains}/1.85.0-aarch64-apple-darwin/bin/rust-analyzer`;
    const found = discoverRustAnalyzer(
      deps({
        projectRoot: "/repo",
        files: { "/repo/rust-toolchain.toml": 'channel = "1.85.0"' },
        dirs: { [toolchains]: ["stable-aarch64-apple-darwin", "1.85.0-aarch64-apple-darwin"] },
        versions: { [stable]: { kind: "ok", stdout: BANNER }, [pinned]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: pinned, tier: "rustup" });
  });

  it("tier 3: with no pin the glob takes any toolchain that answers", () => {
    const toolchains = `${HOME}/.rustup/toolchains`;
    const stable = `${toolchains}/stable-aarch64-apple-darwin/bin/rust-analyzer`;
    const found = discoverRustAnalyzer(
      deps({
        dirs: { [toolchains]: ["stable-aarch64-apple-darwin"] },
        versions: { [stable]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(found).toMatchObject({ path: stable, tier: "rustup" });
  });

  it("tier 4: Homebrew /opt/homebrew/bin before /usr/local/bin", () => {
    const found = discoverRustAnalyzer(
      deps({
        versions: {
          "/opt/homebrew/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
          "/usr/local/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
        },
      }),
    );
    expect(found).toMatchObject({ path: "/opt/homebrew/bin/rust-analyzer", tier: "homebrew" });
  });

  it("tier 5: asdf shim under ASDF_DATA_DIR, then installs/rust/*/bin", () => {
    const shim = "/data/asdf/shims/rust-analyzer";
    const install = "/data/asdf/installs/rust/1.85.0/bin/rust-analyzer";
    const viaShim = discoverRustAnalyzer(
      deps({ env: { ASDF_DATA_DIR: "/data/asdf" }, versions: { [shim]: { kind: "ok", stdout: BANNER } } }),
    );
    expect(viaShim).toMatchObject({ path: shim, tier: "asdf" });
    const viaInstall = discoverRustAnalyzer(
      deps({
        env: { ASDF_DATA_DIR: "/data/asdf" },
        dirs: { "/data/asdf/installs/rust": ["1.85.0"] },
        versions: { [install]: { kind: "ok", stdout: BANNER } },
      }),
    );
    expect(viaInstall).toMatchObject({ path: install, tier: "asdf" });
  });

  it("tier 5: asdf defaults to ~/.asdf without ASDF_DATA_DIR", () => {
    const shim = `${HOME}/.asdf/shims/rust-analyzer`;
    expect(discoverRustAnalyzer(deps({ versions: { [shim]: { kind: "ok", stdout: BANNER } } }))).toMatchObject({
      path: shim,
      tier: "asdf",
    });
  });

  it("a timed-out or unparseable --version moves on to the next tier", () => {
    const found = discoverRustAnalyzer(
      deps({
        env: { CODEGRAPH_RUST_ANALYZER_PATH: "/opt/ra/slow", PATH: "/a/bin" },
        versions: {
          "/opt/ra/slow": { kind: "timed-out" },
          "/a/bin/rust-analyzer": { kind: "ok", stdout: "rust-analyzer: garbage" },
          "/opt/homebrew/bin/rust-analyzer": { kind: "ok", stdout: BANNER },
        },
      }),
    );
    expect(found).toMatchObject({ path: "/opt/homebrew/bin/rust-analyzer", tier: "homebrew" });
  });

  it("probes --version with a 5 s timeout", () => {
    const host = deps({
      env: { CODEGRAPH_RUST_ANALYZER_PATH: "/opt/ra/rust-analyzer" },
      versions: { "/opt/ra/rust-analyzer": { kind: "ok", stdout: BANNER } },
    });
    discoverRustAnalyzer(host);
    expect(host.run).toHaveBeenCalledWith("/opt/ra/rust-analyzer", ["--version"], 5000);
  });

  it("answers null when no tier holds a working binary", () => {
    expect(discoverRustAnalyzer(deps({}))).toBeNull();
  });
});

describe("createRustAnalyzerResolver", () => {
  it("memoizes the discovery per project root", () => {
    const discover = vi.fn(() => null);
    const resolve = createRustAnalyzerResolver(discover);
    resolve("/repo");
    resolve("/repo");
    resolve("/other");
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe("rustAnalyzerInstallHintFor", () => {
  it("is the exact user-facing line", () => {
    expect(RUST_ANALYZER_INSTALL_HINT).toBe(
      "rust-analyzer not found — install with 'rustup component add rust-analyzer' (or 'brew install rust-analyzer'), or set CODEGRAPH_RUST_ANALYZER_PATH",
    );
  });

  it("answers the hint when the index holds Rust and no binary is found", () => {
    expect(rustAnalyzerInstallHintFor(["typescript", "rust"], () => null)).toBe(RUST_ANALYZER_INSTALL_HINT);
  });

  it("stays silent — without probing — when the index holds no Rust", () => {
    const locate = vi.fn(() => null);
    expect(rustAnalyzerInstallHintFor(["typescript", "ruby"], locate)).toBeNull();
    expect(locate).not.toHaveBeenCalled();
  });

  it("stays silent when a binary is found", () => {
    const found = { path: "/x", tier: "path" as const, version: "1", commit: "a", date: "2025-01-01" };
    expect(rustAnalyzerInstallHintFor(["rust"], () => found)).toBeNull();
  });
});
