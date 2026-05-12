import { describe, expect, it } from "vitest";

import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
  ProjectNotRegisteredError,
} from "../../../src/core/api/errors.js";

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
    expect(e.message).toContain("regex");
  });

  it("PathDoesNotExistError quotes the path", () => {
    const e = new PathDoesNotExistError("/nope");
    expect(e.message).toContain("/nope");
  });
});
