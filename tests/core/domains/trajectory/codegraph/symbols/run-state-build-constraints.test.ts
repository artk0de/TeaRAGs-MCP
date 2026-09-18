/**
 * `CodegraphRunState.buildConstraintsByFile` (bd tea-rags-mcp-e6xx) — each
 * walked file's build constraint under its own path, the run-global view Go's
 * resolver reads to tell build-tag twins apart. The map describes the file as
 * it is NOW: a re-walk replaces the entry, and a walk that finds no constraint
 * removes it.
 */

import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const goFile = (relPath: string, buildConstraint?: string): FileExtraction => ({
  relPath,
  language: "go",
  imports: [],
  fileScope: [],
  chunks: [],
  ...(buildConstraint === undefined ? {} : { buildConstraint }),
});

describe("CodegraphRunState — build constraints by file", () => {
  it("records each walked file's constraint under its path", () => {
    const state = new CodegraphRunState();
    state.absorb(goFile("binding/binding.go", "!nomsgpack"), []);
    state.absorb(goFile("binding/binding_nomsgpack.go", "nomsgpack"), []);
    state.absorb(goFile("binding/json.go"), []);
    expect(state.buildConstraintsByFile).toEqual({
      "binding/binding.go": "!nomsgpack",
      "binding/binding_nomsgpack.go": "nomsgpack",
    });
  });

  it("replaces a re-walked file's constraint, and drops it when the file no longer declares one", () => {
    const state = new CodegraphRunState();
    state.absorb(goFile("a.go", "linux"), []);
    state.absorb(goFile("a.go", "darwin"), []);
    expect(state.buildConstraintsByFile["a.go"]).toBe("darwin");
    state.absorb(goFile("a.go"), []);
    expect(state.buildConstraintsByFile).toEqual({});
  });

  it("is emptied by every run-reset seam", () => {
    for (const reset of ["clearForNextRun", "clearAll"] as const) {
      const state = new CodegraphRunState();
      state.absorb(goFile("a.go", "linux"), []);
      state[reset]();
      expect(state.buildConstraintsByFile, reset).toEqual({});
    }
  });
});
