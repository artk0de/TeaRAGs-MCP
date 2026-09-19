import { describe, expect, it } from "vitest";

import { importSpecifierNamesReceiver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-import-basename-match.js";

describe("importSpecifierNamesReceiver", () => {
  it("matches a kebab-case module basename to its PascalCase receiver across source extensions", () => {
    expect(importSpecifierNamesReceiver("../rank-module.js", "RankModule")).toBe(true);
    expect(importSpecifierNamesReceiver("./foo.ts", "Foo")).toBe(true);
    expect(importSpecifierNamesReceiver("./view.tsx", "View")).toBe(true);
    expect(importSpecifierNamesReceiver("./types.d.ts", "types")).toBe(true);
    expect(importSpecifierNamesReceiver("./other.ts", "Foo")).toBe(false);
  });

  it("strips the ESM / CJS TypeScript extensions, declarations included (bd tea-rags-mcp-x9qsh)", () => {
    // `import * as worker from "./sync-worker.mts"; worker.run()` — the
    // basename kept its `.mts`, normalised to `syncworkermts`, and never
    // matched the receiver, so the import could not name the call's module.
    expect(importSpecifierNamesReceiver("./sync-worker.mts", "SyncWorker")).toBe(true);
    expect(importSpecifierNamesReceiver("./sync-worker.cts", "syncWorker")).toBe(true);
    expect(importSpecifierNamesReceiver("./types.d.mts", "types")).toBe(true);
    expect(importSpecifierNamesReceiver("./types.d.cts", "Types")).toBe(true);
  });

  it("names the directory of a specifier written with a trailing slash (bd tea-rags-mcp-unt4v)", () => {
    // `import utils from "./utils/"` — the last `/`-segment is "", which no
    // receiver normalises to, so the directory module was never matched.
    expect(importSpecifierNamesReceiver("./utils/", "utils")).toBe(true);
    expect(importSpecifierNamesReceiver("../rank-module/", "RankModule")).toBe(true);
    expect(importSpecifierNamesReceiver("./utils/", "other")).toBe(false);
    expect(importSpecifierNamesReceiver("./", "utils")).toBe(false);
  });
});
