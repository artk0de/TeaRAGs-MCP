import { describe, expect, it } from "vitest";

import { fileScopedSymbolKey, parseFileScopedSymbolKey } from "../../../../src/core/contracts/types/codegraph.js";

/**
 * bd tea-rags-mcp-oxnvl — the ONE place the `(relPath, symbolId)` composite key
 * is spelled. `::` cannot be the separator (Ruby symbolIds contain it), so the
 * key uses `|`, encodes relPath FIRST, and splits on the FIRST occurrence: a
 * relPath never contains a pipe, but a symbolId genuinely can.
 */
describe("fileScopedSymbolKey / parseFileScopedSymbolKey", () => {
  it("round-trips a plain TypeScript ref", () => {
    const ref = { relPath: "src/ui/BaseTable.tsx", symbolId: "BaseTable" };
    expect(fileScopedSymbolKey(ref)).toBe("src/ui/BaseTable.tsx|BaseTable");
    expect(parseFileScopedSymbolKey(fileScopedSymbolKey(ref))).toEqual(ref);
  });

  it("round-trips a Ruby symbolId carrying `::` and `#`", () => {
    const ref = { relPath: "app/models/user.rb", symbolId: "Acme::Auth::User#save" };
    expect(parseFileScopedSymbolKey(fileScopedSymbolKey(ref))).toEqual(ref);
  });

  it("round-trips a Ruby operator method whose symbolId IS the separator", () => {
    // `def |(other)` in `class Matrix` is an ordinary method definition — the
    // symbolId legitimately ends in a pipe. Splitting on the LAST separator
    // would return `Matrix#` and an empty relPath.
    const ref = { relPath: "lib/matrix.rb", symbolId: "Matrix#|" };
    expect(fileScopedSymbolKey(ref)).toBe("lib/matrix.rb|Matrix#|");
    expect(parseFileScopedSymbolKey(fileScopedSymbolKey(ref))).toEqual(ref);
  });

  it("splits on the FIRST separator so a symbolId containing one survives", () => {
    const ref = { relPath: "a.ts", symbolId: "weird|name" };
    expect(parseFileScopedSymbolKey(fileScopedSymbolKey(ref))).toEqual(ref);
  });

  it("distinguishes two namesakes in different files", () => {
    const ui = fileScopedSymbolKey({ relPath: "ui/BaseTable.tsx", symbolId: "BaseTable" });
    const admin = fileScopedSymbolKey({ relPath: "admin/BaseTable.tsx", symbolId: "BaseTable" });
    expect(ui).not.toBe(admin);
  });
});
