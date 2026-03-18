import { describe, expect, it } from "vitest";

import {
  GitBlameFailedError,
  GitLogTimeoutError,
  GitNotAvailableError,
  StaticParseFailedError,
  TrajectoryError,
  TrajectoryGitError,
  TrajectoryStaticError,
} from "../../../../src/core/domains/trajectory/errors.js";
import { TeaRagsError } from "../../../../src/core/infra/errors.js";

describe("TrajectoryError hierarchy", () => {
  describe("TrajectoryError (abstract)", () => {
    it("cannot be instantiated directly — verified via subclass", () => {
      const err = new GitBlameFailedError("file.ts");
      expect(err).toBeInstanceOf(TrajectoryError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("GitBlameFailedError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new GitBlameFailedError("src/main.ts");
      expect(err.code).toBe("TRAJECTORY_GIT_BLAME_FAILED");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("src/main.ts");
      expect(err.name).toBe("GitBlameFailedError");
    });

    it("multi-level instanceof chain is correct", () => {
      const err = new GitBlameFailedError("file.ts");
      expect(err).toBeInstanceOf(GitBlameFailedError);
      expect(err).toBeInstanceOf(TrajectoryGitError);
      expect(err).toBeInstanceOf(TrajectoryError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves cause when provided", () => {
      const cause = new Error("git process crashed");
      const err = new GitBlameFailedError("file.ts", cause);
      expect(err.cause).toBe(cause);
    });

    it("cause is undefined when not provided", () => {
      const err = new GitBlameFailedError("file.ts");
      expect(err.cause).toBeUndefined();
    });

    it("toUserMessage() includes code and hint", () => {
      const err = new GitBlameFailedError("file.ts");
      const msg = err.toUserMessage();
      expect(msg).toContain("TRAJECTORY_GIT_BLAME_FAILED");
      expect(msg).toContain("Hint:");
    });
  });

  describe("GitLogTimeoutError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new GitLogTimeoutError(30000);
      expect(err.code).toBe("TRAJECTORY_GIT_LOG_TIMEOUT");
      expect(err.httpStatus).toBe(504);
      expect(err.message).toContain("30000");
      expect(err.name).toBe("GitLogTimeoutError");
    });

    it("multi-level instanceof chain is correct", () => {
      const err = new GitLogTimeoutError(5000);
      expect(err).toBeInstanceOf(GitLogTimeoutError);
      expect(err).toBeInstanceOf(TrajectoryGitError);
      expect(err).toBeInstanceOf(TrajectoryError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves cause when provided", () => {
      const cause = new Error("ETIMEDOUT");
      const err = new GitLogTimeoutError(5000, cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("GitNotAvailableError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new GitNotAvailableError();
      expect(err.code).toBe("TRAJECTORY_GIT_NOT_AVAILABLE");
      expect(err.httpStatus).toBe(503);
      expect(err.name).toBe("GitNotAvailableError");
    });

    it("multi-level instanceof chain is correct", () => {
      const err = new GitNotAvailableError();
      expect(err).toBeInstanceOf(GitNotAvailableError);
      expect(err).toBeInstanceOf(TrajectoryGitError);
      expect(err).toBeInstanceOf(TrajectoryError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves cause when provided", () => {
      const cause = new Error("ENOENT: git");
      const err = new GitNotAvailableError(cause);
      expect(err.cause).toBe(cause);
    });
  });

  describe("StaticParseFailedError", () => {
    it("has correct code, httpStatus, and message", () => {
      const err = new StaticParseFailedError("component.tsx");
      expect(err.code).toBe("TRAJECTORY_STATIC_PARSE_FAILED");
      expect(err.httpStatus).toBe(500);
      expect(err.message).toContain("component.tsx");
      expect(err.name).toBe("StaticParseFailedError");
    });

    it("multi-level instanceof chain is correct", () => {
      const err = new StaticParseFailedError("file.ts");
      expect(err).toBeInstanceOf(StaticParseFailedError);
      expect(err).toBeInstanceOf(TrajectoryStaticError);
      expect(err).toBeInstanceOf(TrajectoryError);
      expect(err).toBeInstanceOf(TeaRagsError);
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves cause when provided", () => {
      const cause = new Error("SyntaxError");
      const err = new StaticParseFailedError("file.ts", cause);
      expect(err.cause).toBe(cause);
    });
  });
});
