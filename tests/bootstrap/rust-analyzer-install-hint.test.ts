import { describe, expect, it, vi } from "vitest";

import { createRustAnalyzerInstallHintLookup } from "../../src/bootstrap/rust-analyzer-install-hint.js";
import {
  RUST_ANALYZER_INSTALL_HINT,
  type RustAnalyzerDiscoveryDeps,
  type RustAnalyzerExecutable,
} from "../../src/core/adapters/rust-analyzer/index.js";

const FOUND = { path: "/opt/homebrew/bin/rust-analyzer" } as unknown as RustAnalyzerExecutable;

function config(over: { codegraph?: boolean; rustAnalyzer?: boolean; path?: string } = {}) {
  return {
    codegraph: {
      enabled: over.codegraph ?? true,
      rustAnalyzer: { enabled: over.rustAnalyzer ?? true, path: over.path },
    },
  };
}

describe("createRustAnalyzerInstallHintLookup", () => {
  it("answers the hint when Rust is indexed and no binary is found", () => {
    const lookup = createRustAnalyzerInstallHintLookup(config(), () => null);
    expect(lookup?.({ path: "/p", languages: ["rust", "typescript"] })).toBe(RUST_ANALYZER_INSTALL_HINT);
  });

  it("answers null when a binary is found", () => {
    const lookup = createRustAnalyzerInstallHintLookup(config(), () => FOUND);
    expect(lookup?.({ path: "/p", languages: ["rust"] })).toBeNull();
  });

  it("answers null without probing when the index holds no Rust", () => {
    const discover = vi.fn(() => null);
    const lookup = createRustAnalyzerInstallHintLookup(config(), discover);
    expect(lookup?.({ path: "/p", languages: ["typescript"] })).toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  it("builds no lookup when CODEGRAPH_RUST_ANALYZER=0", () => {
    expect(createRustAnalyzerInstallHintLookup(config({ rustAnalyzer: false }), () => null)).toBeNull();
  });

  it("builds no lookup when codegraph is disabled", () => {
    expect(createRustAnalyzerInstallHintLookup(config({ codegraph: false }), () => null)).toBeNull();
  });

  it("honours codegraph.rustAnalyzer.path as CODEGRAPH_RUST_ANALYZER_PATH and discovers per project root", () => {
    const seen: RustAnalyzerDiscoveryDeps[] = [];
    const lookup = createRustAnalyzerInstallHintLookup(config({ path: "/custom/ra" }), (deps) => {
      seen.push(deps);
      return null;
    });
    lookup?.({ path: "/proj", languages: ["rust"] });
    expect(seen[0]?.env.CODEGRAPH_RUST_ANALYZER_PATH).toBe("/custom/ra");
    expect(seen[0]?.projectRoot).toBe("/proj");
  });

  it("memoizes discovery per project root", () => {
    const discover = vi.fn(() => null);
    const lookup = createRustAnalyzerInstallHintLookup(config(), discover);
    lookup?.({ path: "/proj", languages: ["rust"] });
    lookup?.({ path: "/proj", languages: ["rust"] });
    expect(discover).toHaveBeenCalledTimes(1);
  });
});
