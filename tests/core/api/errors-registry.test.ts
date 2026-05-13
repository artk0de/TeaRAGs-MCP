import { describe, expect, it } from "vitest";

import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
  ProjectNotRegisteredError,
} from "../../../src/core/api/errors.js";
import { RegistryFileCorruptedError, RegistryWriteError } from "../../../src/core/infra/registry/errors.js";

describe("project registry errors", () => {
  it("ProjectNotRegisteredError lists available names in message", () => {
    const e = new ProjectNotRegisteredError("missing", ["a", "b"]);
    expect(e.message).toContain("missing");
    expect(e.message).toContain("a");
    expect(e.message).toContain("b");
  });

  it("ProjectNameNotUniqueError references existing collection", () => {
    const e = new ProjectNameNotUniqueError("x", "code_abc");
    expect(e.message).toContain("code_abc");
  });

  it("ProjectNameInvalidError reports reason", () => {
    const e = new ProjectNameInvalidError("BAD", "regex");
    expect(e.message).toContain("contains invalid characters");
    expect(new ProjectNameInvalidError("X", "tooLong").message).toContain("exceeds maximum length");
    expect(new ProjectNameInvalidError("", "empty").message).toContain("is empty");
  });

  it("PathDoesNotExistError quotes the path", () => {
    const e = new PathDoesNotExistError("/nope");
    expect(e.message).toContain("/nope");
  });

  it("RegistryFileCorruptedError exposes the path and reason", () => {
    const e = new RegistryFileCorruptedError("/data/registry.json", "JSON parse failed: bad token");
    expect(e.message).toContain("/data/registry.json");
    expect(e.message).toContain("JSON parse failed");
    expect(e.code).toBe("INFRA_REGISTRY_FILE_CORRUPTED");
  });

  it("RegistryWriteError keeps Error cause and drops non-Error cause", () => {
    const inner = new Error("disk full");
    const withError = new RegistryWriteError("/data/registry.json", inner);
    expect(withError.cause).toBe(inner);
    expect(withError.code).toBe("INFRA_REGISTRY_WRITE_FAILED");

    // Non-Error cause (e.g. a thrown string) is intentionally dropped to keep
    // the typed-error contract: `cause` is `Error | undefined`.
    const withString = new RegistryWriteError("/data/registry.json", "raw string");
    expect(withString.cause).toBeUndefined();
  });
});
