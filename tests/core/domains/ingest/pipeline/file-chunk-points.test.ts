import { afterEach, describe, expect, it } from "vitest";

import { sourceContentSkipReason } from "../../../../../src/core/domains/ingest/pipeline/file-chunk-points.js";
import { installDeclaredTestFiles } from "../../../../../src/core/primitives/paths/file-classification/index.js";

const FAKE_SECRET_SOURCE = 'const API_KEY = "sk_test_0123456789abcdefghijklmnop";\n';

describe("sourceContentSkipReason — secrets gate (bd tea-rags-mcp-52wk3.10)", () => {
  afterEach(() => {
    installDeclaredTestFiles("/repo", []);
  });

  it("does not skip a declared test file holding a fake secret", () => {
    installDeclaredTestFiles("/repo", ["src/testutil.rs"]);

    expect(
      sourceContentSkipReason("/repo/src/testutil.rs", "src/testutil.rs", FAKE_SECRET_SOURCE, "rust", "/repo"),
    ).toBe(undefined);
  });

  it("still skips the same content in a production file", () => {
    installDeclaredTestFiles("/repo", ["src/testutil.rs"]);

    expect(sourceContentSkipReason("/repo/src/config.rs", "src/config.rs", FAKE_SECRET_SOURCE, "rust", "/repo")).toBe(
      "secrets",
    );
  });

  it("reads only the declared set of its own project root", () => {
    installDeclaredTestFiles("/other", ["src/testutil.rs"]);
    try {
      expect(
        sourceContentSkipReason("/repo/src/testutil.rs", "src/testutil.rs", FAKE_SECRET_SOURCE, "rust", "/repo"),
      ).toBe("secrets");
    } finally {
      installDeclaredTestFiles("/other", []);
    }
  });
});
