import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { BashCallResolver, mapBashSourceToFile } from "../../../../../../src/core/domains/language/bash/resolver/bash-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function ctx(
  callerFile: string,
  imports: { importText: string; startLine: number }[],
  table: InMemoryGlobalSymbolTable,
): CallContext {
  return { callerFile, callerScope: [], imports, symbolTable: table };
}

describe("mapBashSourceToFile", () => {
  it("relative path resolves against caller dir", () => {
    expect(mapBashSourceToFile("./other.sh", "scripts/main.sh")).toBe("scripts/other.sh");
  });

  it("parent path normalises", () => {
    expect(mapBashSourceToFile("../lib/helpers.sh", "scripts/main.sh")).toBe("lib/helpers.sh");
  });
});

describe("BashCallResolver", () => {
  it("resolves bare function call when unique in table", () => {
    const r = new BashCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("helpers.sh", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "helpers.sh", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      ctx("main.sh", [], t),
    );
    expect(target?.targetRelPath).toBe("helpers.sh");
  });

  it("disambiguates by source list when global short-name has multiple matches", () => {
    const r = new BashCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("scripts/a.sh", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "scripts/a.sh", scope: [] },
    ]);
    t.upsertFile("scripts/b.sh", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "scripts/b.sh", scope: [] },
    ]);
    // Caller sources only a.sh, so the call must resolve to a.sh
    // despite the ambiguous global lookup.
    const target = r.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      ctx("scripts/main.sh", [{ importText: "./a.sh", startLine: 1 }], t),
    );
    expect(target?.targetRelPath).toBe("scripts/a.sh");
  });

  it("returns null when ambiguous and no source list narrows it", () => {
    const r = new BashCallResolver();
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("a.sh", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "a.sh", scope: [] },
    ]);
    t.upsertFile("b.sh", [
      { symbolId: "do_thing", fqName: "do_thing", shortName: "do_thing", relPath: "b.sh", scope: [] },
    ]);
    const target = r.resolve(
      { callText: "do_thing", receiver: null, member: "do_thing", startLine: 1 },
      ctx("main.sh", [], t),
    );
    expect(target).toBeNull();
  });
});
