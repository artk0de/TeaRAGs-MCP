import { describe, expect, it, vi } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  RustExternalSignatureSources,
  RustExternalSignatureTable,
  RustExternalSourcesOfProject,
} from "../../../../../../src/core/contracts/types/language.js";
import { RustResolveEnvironmentCache } from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment-cache.js";
import {
  rustExternalSignaturesOf,
  RustResolveEnvironment,
  withRustResolveEnvironment,
} from "../../../../../../src/core/domains/language/rust/resolver/resolve-environment.js";
import { RustCallResolver } from "../../../../../../src/core/domains/language/rust/resolver/rust-resolver.js";
import {
  RustWorkspaceCrateMap,
  rustWorkspaceCratesOf,
} from "../../../../../../src/core/domains/language/rust/resolver/workspace-crates.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd s3i8m.7 T2 — the Rust resolver's pass-start seam loads the project's
 * external signature table through the injected sources port and carries it
 * on `CallContext.languageConfig` beside the workspace crate map, as one
 * `RustResolveEnvironment`. Nothing reads the table yet (T3).
 */
const ROOT = "/nonexistent/s3i8m7-root";

const NOTHING_FOUND: RustExternalSourcesOfProject = {
  std: undefined,
  dependencies: [],
  lockDigest: undefined,
  missingCrates: [],
};
const STD_FOUND: RustExternalSourcesOfProject = {
  ...NOTHING_FOUND,
  std: {
    cacheKey: "std/abc",
    readSources: () => [{ crate: "std", relPath: "lib.rs", source: "pub struct Marker;\n" }],
  },
};

function stubSources(found: RustExternalSourcesOfProject): RustExternalSignatureSources {
  return { locate: vi.fn(() => found), readCached: vi.fn(() => undefined), writeCached: vi.fn(), sizeCapBytes: 1 };
}

function ctx(): CallContext {
  return {
    callerFile: "src/main.rs",
    callerScope: [],
    callerLanguage: "rust",
    importText: [],
    symbolTable: new InMemoryGlobalSymbolTable(),
    projectRoot: ROOT,
  } as unknown as CallContext;
}

describe("RustResolveEnvironment on the call context", () => {
  it("carries the crate map and the signature table, each read by its own accessor", () => {
    const crates = RustWorkspaceCrateMap.fromManifests([]);
    const signatures = { identity: "x" } as unknown as RustExternalSignatureTable;
    const carried = withRustResolveEnvironment(ctx(), new RustResolveEnvironment(crates, signatures));
    expect(rustWorkspaceCratesOf(carried)).toBe(crates);
    expect(rustExternalSignaturesOf(carried)).toBe(signatures);
  });

  it("allocates nothing without an environment and answers undefined off the resolver's entry paths", () => {
    const plain = ctx();
    expect(withRustResolveEnvironment(plain, undefined)).toBe(plain);
    expect(rustWorkspaceCratesOf(plain)).toBeUndefined();
    expect(rustExternalSignaturesOf(plain)).toBeUndefined();
  });
});

describe("RustResolveEnvironmentCache", () => {
  it("is undefined when neither a manifest reader nor a sources port is injected", () => {
    const cache = new RustResolveEnvironmentCache();
    cache.reload(ROOT);
    expect(cache.forRoot(ROOT)).toBeUndefined();
  });

  it("returns the same environment until reload, and the loaded table on it", () => {
    const sources = stubSources(STD_FOUND);
    const cache = new RustResolveEnvironmentCache(undefined, sources);
    cache.reload(ROOT);
    const first = cache.forRoot(ROOT);
    expect(first?.signatures?.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.crates).toBeUndefined();
    expect(cache.forRoot(ROOT)).toBe(first);
    cache.reload(ROOT);
    expect(cache.forRoot(ROOT)).not.toBe(first);
  });
});

describe("Rust external signature sources — injection path", () => {
  it("RustCallResolver.prepareResolvePass locates the project's sources", () => {
    const sources = stubSources(NOTHING_FOUND);
    const resolver = new RustCallResolver(undefined, undefined, sources);
    resolver.prepareResolvePass({ expectedFileCount: 1, projectRoot: ROOT });
    expect(sources.locate).toHaveBeenCalledWith(ROOT);
  });
});
