import { describe, expect, it, vi } from "vitest";

import type { ManifestFile, ManifestFilesReader } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { GoModuleMapCache } from "../../../../../../src/core/domains/language/go/resolver/strategies/go-module-map.js";

/**
 * bd tea-rags-mcp-2wu2h (W7) — `domains/language` is a leaf and may not reach
 * the manifest walk itself: the go.mod reader is INJECTED. A stub reader that
 * answers a synthetic go.mod set, for a root that does not exist on disk, must
 * be what the module map is built from — and absent a reader there is nothing
 * to read, so the resolver falls back to GOPATH-shaped matching.
 */
const ROOT = "/nonexistent/2wu2h-root";

function stubReader(files: ManifestFile[]): ManifestFilesReader & ReturnType<typeof vi.fn> {
  return vi.fn((_root: string, _matches: (fileName: string) => boolean) => files) as never;
}

describe("GoModuleMapCache — injected manifest reader", () => {
  it("builds the module map from what the injected reader answers", () => {
    const reader = stubReader([
      { relDir: "", fileName: "go.mod", content: "module example.com/synthetic\n" },
      { relDir: "tools/lint", fileName: "go.mod", content: "module example.com/synthetic/tools/lint\n" },
    ]);
    const map = new GoModuleMapCache(reader).forRoot(ROOT);
    expect(map?.packageDirOf("example.com/synthetic/api")).toBe("api");
    expect(map?.packageDirOf("example.com/synthetic/tools/lint/rules")).toBe("tools/lint/rules");
    expect(reader).toHaveBeenCalledTimes(1);
    const [root, matches] = reader.mock.calls[0] as [string, (fileName: string) => boolean];
    expect(root).toBe(ROOT);
    expect(matches("go.mod")).toBe(true);
    expect(matches("go.sum")).toBe(false);
  });

  it("answers no module map without a reader — nothing to read", () => {
    expect(new GoModuleMapCache().forRoot(ROOT)).toBeUndefined();
  });
});

describe("GoLanguage / LanguageFactory — the reader reaches the resolver", () => {
  it("GoLanguage re-reads through the injected reader at pass start", () => {
    const reader = stubReader([{ relDir: "", fileName: "go.mod", content: "module example.com/synthetic\n" }]);
    new GoLanguage(undefined, reader).resolver.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]?.[0]).toBe(ROOT);
  });

  it("LanguageFactory threads its manifestFilesReader into the Go provider", () => {
    const reader = stubReader([{ relDir: "", fileName: "go.mod", content: "module example.com/synthetic\n" }]);
    const go = new LanguageFactory({ manifestFilesReader: reader, isGrammarPackageInstalled: () => true }).create("go");
    go.resolver?.prepareResolvePass?.({ expectedFileCount: 1, projectRoot: ROOT });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0]?.[0]).toBe(ROOT);
  });
});
