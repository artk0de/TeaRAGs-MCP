/**
 * Building a project's external signature table from the injected sources port
 * (bd s3i8m.7 T2): std and each dependency extracted once and cached under an
 * extractor-versioned key, merged into one table whose identity digest moves
 * with every input that can change an answer.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRustExternalSignatureSources } from "../../../../../../src/core/adapters/rust-signatures/index.js";
import type {
  RustExternalSignatureSources,
  RustExternalSignatureTableData,
  RustExternalSourcesOfProject,
} from "../../../../../../src/core/contracts/index.js";
import {
  buildRustExternalSignatureTable,
  loadRustSourceParser,
  RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION,
  RustExternalSignatureTableCache,
} from "../../../../../../src/core/domains/language/rust/external-signatures/index.js";

const FIXTURES = join(process.cwd(), "tests/fixtures/rust-external-signatures");
const PROJECT = join(FIXTURES, "project");
const ENV = {
  CARGO_HOME: join(FIXTURES, "cargo-home"),
  RUST_SRC_PATH: join(FIXTURES, "sysroot/lib/rustlib/src/rust/library"),
};

/** A sources port over a canned location and an in-memory cache. */
function memorySources(found: RustExternalSourcesOfProject, cache = new Map<string, RustExternalSignatureTableData>()) {
  const port: RustExternalSignatureSources = {
    locate: vi.fn(() => found),
    readCached: vi.fn((key: string) => cache.get(key)),
    writeCached: vi.fn((key: string, data: RustExternalSignatureTableData) => void cache.set(key, data)),
    sizeCapBytes: 100,
  };
  return { port, cache };
}

const STD_SOURCES = [
  { crate: "std", relPath: "lib.rs", source: "pub struct Marker;\nimpl Marker { pub fn id(&self) -> u32 { 0 } }\n" },
];
const DEMO_SOURCES = [
  {
    crate: "demo",
    relPath: "lib.rs",
    source: "pub struct Client;\nimpl Client { pub fn name(&self) -> String { todo!() } }\n",
  },
];

function location(overrides: Partial<RustExternalSourcesOfProject> = {}): RustExternalSourcesOfProject {
  return {
    std: { cacheKey: "std/abc", readSources: () => STD_SOURCES },
    dependencies: [{ cacheKey: "crates/demo-0.1.0", readSources: () => DEMO_SOURCES }],
    lockDigest: "lock-1",
    missingCrates: [],
    ...overrides,
  };
}

describe("buildRustExternalSignatureTable", () => {
  it("extracts std and each dependency separately, caches each under an extractor-versioned key and merges them", () => {
    const { port, cache } = memorySources(location());
    const table = buildRustExternalSignatureTable(port, "/project", loadRustSourceParser);
    const x = `-x${RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION}`;
    expect([...cache.keys()].sort()).toEqual([`crates/demo-0.1.0${x}`, `std/abc${x}`]);
    expect(cache.get(`crates/demo-0.1.0${x}`)?.crates).toEqual(["demo"]);
    expect(table?.inherentMember("demo::Client", "name")).toMatchObject({ selfKind: "ref" });
    expect(table?.inherentMember("std::Marker", "id")).toMatchObject({ selfKind: "ref" });
  });

  it("never parses on a cache hit", () => {
    const { port, cache } = memorySources(location());
    buildRustExternalSignatureTable(port, "/project", loadRustSourceParser);
    const parser = vi.fn(loadRustSourceParser);
    const { port: warm } = memorySources(location(), cache);
    const table = buildRustExternalSignatureTable(warm, "/project", parser);
    expect(parser).not.toHaveBeenCalled();
    expect(warm.writeCached).not.toHaveBeenCalled();
    expect(table?.inherentMember("demo::Client", "name")).toBeDefined();
  });

  it("leaves out an over-cap dependency and keeps the rest", () => {
    const { port, cache } = memorySources(
      location({ dependencies: [{ cacheKey: "crates/huge-1.0.0", readSources: () => undefined }] }),
    );
    const table = buildRustExternalSignatureTable(port, "/project", loadRustSourceParser);
    expect([...cache.keys()]).toEqual([`std/abc-x${RUST_EXTERNAL_SIGNATURE_EXTRACTOR_VERSION}`]);
    expect(table?.inherentMember("std::Marker", "id")).toBeDefined();
  });

  it("answers no table when nothing is found", () => {
    const { port } = memorySources(location({ std: undefined, dependencies: [] }));
    expect(buildRustExternalSignatureTable(port, "/project", loadRustSourceParser)).toBeUndefined();
  });

  it("keeps the identity stable for the same inputs and moves it with the lock, the toolchain, the crate set and the cap", () => {
    const identityOf = (found: RustExternalSourcesOfProject, sizeCapBytes = 100): string | undefined => {
      const { port } = memorySources(found);
      return buildRustExternalSignatureTable({ ...port, sizeCapBytes }, "/project", loadRustSourceParser)?.identity;
    };
    const base = identityOf(location());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(identityOf(location())).toBe(base);
    expect(identityOf(location({ lockDigest: "lock-2" }))).not.toBe(base);
    expect(identityOf(location({ std: { cacheKey: "std/def", readSources: () => STD_SOURCES } }))).not.toBe(base);
    expect(identityOf(location({ dependencies: [] }))).not.toBe(base);
    expect(identityOf(location(), 200)).not.toBe(base);
  });
});

describe("RustExternalSignatureTableCache", () => {
  it("is a no-op without an injected sources port", () => {
    const cache = new RustExternalSignatureTableCache();
    cache.reload("/project");
    expect(cache.forRoot("/project")).toBeUndefined();
  });

  it("builds once per root and rebuilds on reload", () => {
    const { port } = memorySources(location());
    const cache = new RustExternalSignatureTableCache(port, loadRustSourceParser);
    const first = cache.forRoot("/project");
    expect(cache.forRoot("/project")).toBe(first);
    expect(port.locate).toHaveBeenCalledTimes(1);
    cache.reload("/project");
    expect(port.locate).toHaveBeenCalledTimes(2);
    expect(cache.forRoot(undefined)).toBeUndefined();
  });
});

describe("external signature table — end to end over the fixture toolchain and cargo home", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "rust-signatures-e2e-"));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("answers std, registry and git dependency members, then reloads warm with the same identity", () => {
    const sources = createRustExternalSignatureSources({ cacheDir, env: ENV, runRustc: () => undefined });
    const cold = buildRustExternalSignatureTable(sources, PROJECT, loadRustSourceParser);
    expect(cold?.canonicalType("Client", ["use demo::Client;"])).toBe("demo::Client");
    expect(cold?.inherentMember("demo::Client", "nickname")).toMatchObject({ selfKind: "ref" });
    expect(cold?.inherentMember("gitdep::Thing", "label")).toMatchObject({ selfKind: "ref" });
    expect(cold?.canonicalType("Mutex", ["use std::sync::Mutex;"])).toBe("std::sync::Mutex");

    const parser = vi.fn(loadRustSourceParser);
    const warm = buildRustExternalSignatureTable(sources, PROJECT, parser);
    expect(parser).not.toHaveBeenCalled();
    expect(warm?.identity).toBe(cold?.identity);
    expect(warm?.inherentMember("gitdep::Thing", "label")).toEqual(cold?.inherentMember("gitdep::Thing", "label"));
  });
});
