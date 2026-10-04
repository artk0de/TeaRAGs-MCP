/**
 * The Swift SDK substrate ships as a JSON asset beside its reader and is read
 * on first use only (bd tea-rags-mcp-bbo1h.3). Importing the reader is on the
 * path of every language-domain import — the chunker worker included — so it
 * must cost nothing until a Swift resolver actually asks a question.
 */

import type * as NodeFs from "node:fs";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

const ASSET = "sdk-vocabulary.generated.json";
const ASSET_URL = new URL(
  "../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.generated.json",
  import.meta.url,
);

describe("Swift SDK vocabulary asset (bd tea-rags-mcp-bbo1h.3)", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("is not read when the reader is imported, and is read once, on the first call", async () => {
    const reads: string[] = [];
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof NodeFs>();
      const tracked = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
        reads.push(String(path));
        return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof actual.readFileSync;
      return { ...actual, readFileSync: tracked, default: { ...actual, readFileSync: tracked } };
    });
    const mod = await import("../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.js");

    expect(reads.filter((p) => p.endsWith(ASSET))).toEqual([]);

    const first = mod.swiftSdkVocabulary();
    expect(mod.swiftSdkVocabulary()).toBe(first);
    expect(first.hasType("Array")).toBe(true);
    expect(reads.filter((p) => p.endsWith(ASSET))).toHaveLength(1);
  });

  it("imports no generated data module statically", () => {
    const source = readFileSync(
      new URL("../../../../../../src/core/domains/language/swift/vocabulary/sdk-vocabulary.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'][^"']*generated[^"']*["']/);
  });

  // Pins of the artifact as generated at the time it moved from a `.ts` string
  // module to this asset (toolchain Swift 6.4, SDKs macosx/iphoneos 27.0,
  // watchos 27.0). A regeneration moves these numbers on purpose; update them
  // together with the asset.
  it("carries the same vocabulary document, with its provenance beside the data", () => {
    const raw = JSON.parse(readFileSync(ASSET_URL, "utf8")) as {
      v: number;
      meta: { generator: string; toolchain: string; modules: string[] };
      types: Record<string, unknown>;
      functions: Record<string, unknown>;
      labelled: Record<string, unknown>;
    };
    expect(raw.v).toBe(1);
    expect(Object.keys(raw.types)).toHaveLength(5772);
    expect(Object.keys(raw.functions)).toHaveLength(90);
    expect(Object.keys(raw.labelled)).toHaveLength(68);
    expect(raw.meta.generator).toBe("scripts/gen-swift-sdk-vocabulary.ts");
    expect(raw.meta.toolchain).toContain("Swift version");
    expect(raw.meta.modules).toContain("Foundation");
  });
});
