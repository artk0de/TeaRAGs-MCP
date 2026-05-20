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
});
