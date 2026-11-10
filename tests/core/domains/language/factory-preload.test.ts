import { describe, expect, it } from "vitest";

import { LanguageFactory } from "../../../../src/core/domains/language/factory.js";

/**
 * bd tea-rags-mcp-zkd96 — the factory reaches per-language provider modules
 * through a lazy, module-path-based registry (dynamic import), so a resolver
 * edit no longer puts every pipeline-booting test into `vitest related`.
 * `create()` stays synchronous and only serves languages whose module was
 * loaded by `preload()` first; the production seams (chunker worker,
 * codegraph runtime, composition) preload before first use.
 */
describe("LanguageFactory preload (lazy provider modules, bd tea-rags-mcp-zkd96)", () => {
  it("create() before preload throws a dedicated not-preloaded error for a supported language", async () => {
    const factory = new LanguageFactory();
    expect(() => factory.create("ruby")).toThrowError(
      expect.objectContaining({ code: "LANGUAGE_MODULE_NOT_PRELOADED" }) as Error,
    );
  });

  it("preload([lang]) then create returns the real provider", async () => {
    const factory = await LanguageFactory.preloaded();
    await factory.preload(["ruby"]);
    expect(factory.create("ruby").kernel).toBeDefined();
  });

  it("preload() with no args loads every supported language", async () => {
    const factory = await LanguageFactory.preloaded();
    await factory.preload();
    for (const lang of factory.supported()) {
      expect(factory.create(lang).kernel).toBeDefined();
    }
  });

  it("preload is idempotent and safe to call concurrently", async () => {
    const factory = await LanguageFactory.preloaded();
    await Promise.all([factory.preload(["python"]), factory.preload(["python"])]);
    await factory.preload(["python"]);
    expect(factory.create("python").kernel).toBeDefined();
  });

  it("unknown languages stay unsupported after a full preload", async () => {
    const factory = await LanguageFactory.preloaded();
    await factory.preload();
    expect(() => factory.create("fortran")).toThrowError(
      expect.objectContaining({ code: "LANGUAGE_UNSUPPORTED" }) as Error,
    );
  });
});
