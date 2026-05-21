import { describe, expect, it } from "vitest";

import { mapImportToFile } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/resolvers/ts/ts-path-mapper.js";

describe("mapImportToFile", () => {
  it("resolves relative paths against caller file", () => {
    const result = mapImportToFile("./bar", "src/foo.ts", { baseUrl: ".", paths: {} });
    expect(result).toBe("src/bar.ts");
  });

  it("resolves parent-relative paths", () => {
    const result = mapImportToFile("../utils/x", "src/a/b/foo.ts", { baseUrl: ".", paths: {} });
    expect(result).toBe("src/a/utils/x.ts");
  });

  it("applies tsconfig paths aliases", () => {
    const result = mapImportToFile("@/lib/foo", "src/foo.ts", {
      baseUrl: ".",
      paths: { "@/*": ["src/*"] },
    });
    expect(result).toBe("src/lib/foo.ts");
  });

  it("returns null for bare npm imports", () => {
    expect(mapImportToFile("react", "src/foo.ts", { baseUrl: ".", paths: {} })).toBeNull();
    expect(mapImportToFile("@anthropic/sdk", "src/foo.ts", { baseUrl: ".", paths: {} })).toBeNull();
  });

  it("preserves existing .ts/.tsx extension when present", () => {
    expect(mapImportToFile("./bar.ts", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/bar.ts");
    expect(mapImportToFile("./view.tsx", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/view.tsx");
  });

  it("rewrites NodeNext .js/.jsx import suffixes to .ts/.tsx (actual source on disk)", () => {
    // TS NodeNext convention: src code writes `import "./foo.js"` but
    // the actual file is `./foo.ts`. Without this rewrite, codegraph
    // edges would target non-existent .js paths and fanIn/fanOut would
    // come back 0 against the .ts-keyed file table.
    expect(mapImportToFile("./config/index.js", "src/bootstrap/factory.ts", { baseUrl: ".", paths: {} })).toBe(
      "src/bootstrap/config/index.ts",
    );
    expect(mapImportToFile("./view.jsx", "src/foo.ts", { baseUrl: ".", paths: {} })).toBe("src/view.tsx");
  });

  it("applies exact-match tsconfig path alias (non-wildcard pattern)", () => {
    // tsconfig.json paths can declare exact aliases like
    //   { "constants": ["src/constants.ts"] }
    // — no `/*` suffix. The mapper's `pattern === importText` branch
    // resolves these directly against baseUrl.
    const result = mapImportToFile("constants", "src/foo.ts", {
      baseUrl: ".",
      paths: { constants: ["src/constants.ts"] },
    });
    expect(result).toBe("src/constants.ts");
  });

  it("exact-match alias with empty target list returns null", () => {
    // Drives the `if (!target) return null` defensive branch inside
    // the exact-match case — paths entry exists but the targets array
    // is empty (degenerate tsconfig).
    const result = mapImportToFile("constants", "src/foo.ts", {
      baseUrl: ".",
      paths: { constants: [] },
    });
    expect(result).toBeNull();
  });

  it("wildcard alias with empty target list returns null", () => {
    // Same defensive branch in the wildcard case — pattern matches
    // import prefix but targets array is empty.
    const result = mapImportToFile("@/foo", "src/foo.ts", {
      baseUrl: ".",
      paths: { "@/*": [] },
    });
    expect(result).toBeNull();
  });
});
