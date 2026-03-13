import { describe, expect, it } from "vitest";

import { staticDerivedSignals as structuralSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";

describe("structuralSignals", () => {
  it("has 6 descriptors", () => {
    expect(structuralSignals).toHaveLength(6);
  });

  it("structural signals declare correct sources", () => {
    for (const d of structuralSignals) {
      if (d.name === "chunkSize") {
        expect(d.sources).toEqual(["methodLines"]);
      } else if (d.name === "chunkDensity") {
        expect(d.sources).toEqual(["methodDensity", "methodLines"]);
      } else {
        expect(d.sources).toEqual([]);
      }
    }
  });

  it("every descriptor has name, description, and extract", () => {
    for (const d of structuralSignals) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(typeof d.extract).toBe("function");
    }
  });

  describe("similarity", () => {
    it("returns the original score from _score", () => {
      const d = structuralSignals.find((s) => s.name === "similarity")!;
      expect(d.extract({ _score: 0.85 })).toBe(0.85);
    });

    it("returns 0 when no score", () => {
      const d = structuralSignals.find((s) => s.name === "similarity")!;
      expect(d.extract({})).toBe(0);
    });
  });

  describe("chunkSize", () => {
    it("normalizes methodLines against 500", () => {
      const d = structuralSignals.find((s) => s.name === "chunkSize")!;
      // 100 lines / 500 = 0.2
      expect(d.extract({ methodLines: 100 })).toBeCloseTo(0.2, 2);
    });

    it("returns 0 when methodLines is missing", () => {
      const d = structuralSignals.find((s) => s.name === "chunkSize")!;
      expect(d.extract({})).toBe(0);
    });

    it("clamps at 1.0 when methodLines exceeds bound", () => {
      const d = structuralSignals.find((s) => s.name === "chunkSize")!;
      expect(d.extract({ methodLines: 1000 })).toBe(1);
    });
  });

  describe("documentation", () => {
    it("returns 1 for docs", () => {
      const d = structuralSignals.find((s) => s.name === "documentation")!;
      expect(d.extract({ isDocumentation: true })).toBe(1);
    });

    it("returns 0 for non-docs", () => {
      const d = structuralSignals.find((s) => s.name === "documentation")!;
      expect(d.extract({ isDocumentation: false })).toBe(0);
    });

    it("returns 0 when field missing", () => {
      const d = structuralSignals.find((s) => s.name === "documentation")!;
      expect(d.extract({})).toBe(0);
    });
  });

  describe("imports", () => {
    it("normalizes import count against 20", () => {
      const d = structuralSignals.find((s) => s.name === "imports")!;
      // 5 imports / 20 = 0.25
      expect(d.extract({ imports: ["a", "b", "c", "d", "e"] })).toBeCloseTo(0.25, 2);
    });

    it("returns 0 when no imports", () => {
      const d = structuralSignals.find((s) => s.name === "imports")!;
      expect(d.extract({})).toBe(0);
    });
  });

  describe("pathRisk", () => {
    it("detects security patterns", () => {
      const d = structuralSignals.find((s) => s.name === "pathRisk")!;
      expect(d.extract({ relativePath: "src/auth/login.ts" })).toBe(1);
      expect(d.extract({ relativePath: "src/security/crypto.ts" })).toBe(1);
      expect(d.extract({ relativePath: "lib/token-manager.ts" })).toBe(1);
    });

    it("returns 0 for safe paths", () => {
      const d = structuralSignals.find((s) => s.name === "pathRisk")!;
      expect(d.extract({ relativePath: "src/utils/math.ts" })).toBe(0);
      expect(d.extract({ relativePath: "tests/helpers.ts" })).toBe(0);
    });

    it("returns 0 when path missing", () => {
      const d = structuralSignals.find((s) => s.name === "pathRisk")!;
      expect(d.extract({})).toBe(0);
    });
  });
});
