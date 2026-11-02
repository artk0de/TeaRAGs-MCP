import { describe, expect, it } from "vitest";

import { compiledModuleDir } from "../../../../src/core/primitives/paths/index.js";

describe("compiledModuleDir", () => {
  it("keeps a compiled module's directory even when the install path holds an earlier /src/", () => {
    expect(compiledModuleDir("/x/.tea-rags/src/TeaRAGs-MCP/build/core/a/pool.js")).toBe(
      "/x/.tea-rags/src/TeaRAGs-MCP/build/core/a",
    );
  });

  it("keeps a compiled module's directory under a node_modules install below /src/", () => {
    expect(compiledModuleDir("/home/u/src/node_modules/tea-rags/build/core/a/pool.js")).toBe(
      "/home/u/src/node_modules/tea-rags/build/core/a",
    );
  });

  it("remaps the LAST /src/ segment to /build/ for a source module", () => {
    expect(compiledModuleDir("/x/src/repo/src/core/a/pool.ts")).toBe("/x/src/repo/build/core/a");
  });

  it("remaps a plain source module to its build directory", () => {
    expect(compiledModuleDir("/repo/src/core/a/pool.ts")).toBe("/repo/build/core/a");
  });

  it("handles backslash separators", () => {
    expect(compiledModuleDir("C:\\u\\src\\repo\\src\\core\\a\\pool.ts")).toBe("C:\\u\\src\\repo\\build\\core\\a");
  });
});
