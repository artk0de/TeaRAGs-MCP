import { describe, expect, it } from "vitest";

import { RUBY_DSL } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("ActiveRecord association / scope declares", () => {
  it("has_many :posts → posts/posts=/post_ids/post_ids= (collection, singularized ids)", () => {
    expect(RUBY_DSL.has_many.declares?.("posts").map((m) => m.name)).toEqual([
      "posts",
      "posts=",
      "post_ids",
      "post_ids=",
    ]);
    expect(RUBY_DSL.has_many.declares?.("posts").every((m) => m.kind === "instance")).toBe(true);
  });

  it("has_many :categories singularizes ies→y for the ids accessor", () => {
    expect(RUBY_DSL.has_many.declares?.("categories").map((m) => m.name)).toContain("category_ids");
  });

  it("has_and_belongs_to_many mirrors has_many (collection)", () => {
    expect(RUBY_DSL.has_and_belongs_to_many.declares?.("roles").map((m) => m.name)).toEqual([
      "roles",
      "roles=",
      "role_ids",
      "role_ids=",
    ]);
  });

  it("has_one :profile → profile/profile=/build_profile/create_profile (singular)", () => {
    expect(RUBY_DSL.has_one.declares?.("profile").map((m) => m.name)).toEqual([
      "profile",
      "profile=",
      "build_profile",
      "create_profile",
    ]);
  });

  it("belongs_to :user → user/user=/build_user/create_user/user_id/user_id=", () => {
    expect(RUBY_DSL.belongs_to.declares?.("user").map((m) => m.name)).toEqual([
      "user",
      "user=",
      "build_user",
      "create_user",
      "user_id",
      "user_id=",
    ]);
  });

  it("scope :active → active static (class method)", () => {
    expect(RUBY_DSL.scope.declares?.("active")).toEqual([{ name: "active", kind: "static" }]);
  });
});
