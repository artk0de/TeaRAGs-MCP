/**
 * The read-only layering view the diff-scoped `layeringBackEdge` family judges
 * against (bd tea-rags-mcp-89k7k.1.19.3): the SAME model the whole-repo
 * layering builds — positions and knots are read off `buildLayeringModel`,
 * never recomputed — plus the two questions a hypothetical NEW component edge
 * asks of it: which knot it would close, and whether it is composition.
 */
import { describe, expect, it } from "vitest";

import type {
  FileDependencyEdge,
  FileDependencyGraph,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  readLayering,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

function file(relPath: string) {
  return { relPath, language: "typescript", symbolCount: 1 };
}

function edge(sourceRelPath: string, targetRelPath: string): FileDependencyEdge {
  return { sourceRelPath, targetRelPath, callWeight: 1 };
}

/** `core` ← `lib` ← `svc` ← `app`, a `side` leaf on core, and `parent/nested` under `parent`. */
function stack(): FileDependencyGraph {
  return {
    files: [
      file("core/a.ts"),
      file("core/b.ts"),
      file("lib/x.ts"),
      file("svc/s.ts"),
      file("app/m.ts"),
      file("side/q.ts"),
      file("parent/own.ts"),
      file("parent/nested/inner.ts"),
    ],
    edges: [
      edge("lib/x.ts", "core/a.ts"),
      edge("svc/s.ts", "lib/x.ts"),
      edge("app/m.ts", "svc/s.ts"),
      edge("side/q.ts", "core/b.ts"),
      edge("parent/own.ts", "core/a.ts"),
    ],
  };
}

describe("readLayering", () => {
  const componentGraph = buildComponentGraph(stack(), []);
  const reading = readLayering(componentGraph);

  it("reads each component's position off the layering model itself", () => {
    const model = buildLayeringModel(componentGraph);
    for (const component of ["core", "lib", "svc", "app", "side"]) {
      expect(reading.positionOf(component)).toEqual(model.positions.get(component));
    }
    expect(reading.positionOf("core")?.level).toBe(0);
    expect(reading.positionOf("app")?.level).toBe(3);
    expect(reading.positionOf("nowhere")).toBeUndefined();
  });

  it("names the knot a new edge would close: every component on a path back from target to source, sorted", () => {
    // core -> svc: svc reaches core through lib, so the edge closes core/lib/svc.
    expect(reading.knotClosedBy("core", "svc")).toEqual(["core", "lib", "svc"]);
    // core -> side: side reaches core, nothing else sits on that path.
    expect(reading.knotClosedBy("core", "side")).toEqual(["core", "side"]);
  });

  it("closes no knot when the target never reaches the source", () => {
    expect(reading.knotClosedBy("side", "app")).toBeUndefined();
    expect(reading.knotClosedBy("lib", "lib")).toBeUndefined();
    expect(reading.knotClosedBy("core", "nowhere")).toBeUndefined();
  });

  it("calls a parent directory and its own nested directory composition, in either direction", () => {
    expect(reading.isComposition("parent", "parent/nested")).toBe(true);
    expect(reading.isComposition("parent/nested", "parent")).toBe(true);
    expect(reading.isComposition("core", "lib")).toBe(false);
  });

  it("lists a component's walked files", () => {
    expect([...reading.filesOf("core")].sort()).toEqual(["core/a.ts", "core/b.ts"]);
    expect(reading.filesOf("nowhere")).toEqual([]);
  });

  it("reuses a model the caller already built", () => {
    const model = buildLayeringModel(componentGraph);
    expect(readLayering(componentGraph, model).positionOf("svc")).toBe(model.positions.get("svc"));
  });
});
