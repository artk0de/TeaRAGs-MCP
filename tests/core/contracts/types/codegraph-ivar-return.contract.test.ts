/**
 * Additive-shape contract tests for `ivarTypes` + `structuredReturnTypes` on
 * `CallContext` and `ivarTypes` mirror on `FileExtraction` (Task 1.1 — Ruby
 * type-source propagation engine, Increment 1).
 *
 * Tests prove:
 * 1. New optional fields can be attached to a `CallContext` literal with valid
 *    `RubyTypeRef` values.
 * 2. A `CallContext` constructed with ONLY pre-existing required fields still
 *    type-checks — the addition is purely additive / backward-compatible.
 * 3. `FileExtraction.ivarTypes` mirrors the same shape.
 */

import { describe, expect, it } from "vitest";

import type { CallContext, FileExtraction } from "../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../src/core/contracts/types/language.js";

describe("CallContext — ivarTypes + structuredReturnTypes (Task 1.1)", () => {
  it("accepts ivarTypes and structuredReturnTypes on a CallContext literal", () => {
    const accountRef: RubyTypeRef = { form: "instance", name: "Account" };
    const userRef: RubyTypeRef = { form: "class", name: "User" };

    const stub = {
      lookupByShortName: () => [],
      lookup: () => [],
      upsertFile: () => undefined,
      removeFile: () => undefined,
      size: () => 0,
      hydrate: () => undefined,
    };

    const ctx: CallContext = {
      callerFile: "app/models/user.rb",
      callerScope: ["User"],
      imports: [],
      symbolTable: stub,
      // New fields under test — Task 1.1
      ivarTypes: {
        User: { "@account": "Account", "@role": "Role" },
      },
      structuredReturnTypes: {
        "User#account": accountRef,
        "User.find": userRef,
      },
    };

    expect(ctx.ivarTypes?.["User"]?.["@account"]).toBe("Account");
    expect(ctx.structuredReturnTypes?.["User#account"]).toEqual({ form: "instance", name: "Account" });
    expect(ctx.structuredReturnTypes?.["User.find"]).toEqual({ form: "class", name: "User" });
  });

  it("CallContext with only pre-existing required fields still type-checks (additive proof)", () => {
    const stub = {
      lookupByShortName: () => [],
      lookup: () => [],
      upsertFile: () => undefined,
      removeFile: () => undefined,
      size: () => 0,
      hydrate: () => undefined,
    };

    // No new fields — must compile and pass without any new properties
    const ctx: CallContext = {
      callerFile: "app/controllers/users_controller.rb",
      callerScope: ["UsersController"],
      imports: [],
      symbolTable: stub,
    };

    // New fields are absent — undefined by default (optional)
    expect(ctx.ivarTypes).toBeUndefined();
    expect(ctx.structuredReturnTypes).toBeUndefined();
  });

  it("FileExtraction.ivarTypes mirrors CallContext.ivarTypes shape", () => {
    const extraction: FileExtraction = {
      relPath: "app/models/user.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
      // Mirror field under test — Task 1.1
      ivarTypes: {
        User: { "@account": "Account" },
        Admin: { "@session": "Session" },
      },
    };

    expect(extraction.ivarTypes?.["User"]?.["@account"]).toBe("Account");
    expect(extraction.ivarTypes?.["Admin"]?.["@session"]).toBe("Session");
  });

  it("FileExtraction without ivarTypes still type-checks (additive proof)", () => {
    const extraction: FileExtraction = {
      relPath: "app/models/post.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
    };

    expect(extraction.ivarTypes).toBeUndefined();
  });

  it("RubyTypeRef union and container variants accepted in structuredReturnTypes", () => {
    const stub = {
      lookupByShortName: () => [],
      lookup: () => [],
      upsertFile: () => undefined,
      removeFile: () => undefined,
      size: () => 0,
      hydrate: () => undefined,
    };

    const unionRef: RubyTypeRef = {
      form: "union",
      members: [
        { form: "instance", name: "Post" },
        { form: "instance", name: "Article" },
      ],
    };
    const containerRef: RubyTypeRef = {
      form: "container",
      element: { form: "instance", name: "Comment" },
    };

    const ctx: CallContext = {
      callerFile: "app/models/feed.rb",
      callerScope: ["Feed"],
      imports: [],
      symbolTable: stub,
      structuredReturnTypes: {
        "Feed#items": unionRef,
        "Feed#comments": containerRef,
      },
    };

    expect(ctx.structuredReturnTypes?.["Feed#items"]).toEqual(unionRef);
    expect(ctx.structuredReturnTypes?.["Feed#comments"]).toEqual(containerRef);
  });
});
