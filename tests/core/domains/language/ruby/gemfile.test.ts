import { describe, expect, it } from "vitest";

import { gemfileGemNames } from "../../../../../src/core/domains/language/ruby/gemfile.js";

describe("gemfileGemNames", () => {
  it("collects declared gems across bare, quoted, and optioned forms", () => {
    const gemfile = [
      'source "https://rubygems.org"',
      'gem "rails", "~> 7.0"',
      "gem 'devise'",
      'gem "dry-initializer", "~> 3.1"',
      'gem "cancancan", require: false',
      'gem("kaminari")',
    ].join("\n");
    const gems = gemfileGemNames(gemfile);
    expect(gems.has("rails")).toBe(true);
    expect(gems.has("devise")).toBe(true);
    expect(gems.has("dry-initializer")).toBe(true);
    expect(gems.has("cancancan")).toBe(true);
    expect(gems.has("kaminari")).toBe(true); // paren form
  });

  it("detects gems inside group blocks", () => {
    const gemfile = [
      'gem "rails"',
      "group :development, :test do",
      '  gem "rspec-rails"',
      '  gem "factory_bot_rails"',
      "end",
    ].join("\n");
    const gems = gemfileGemNames(gemfile);
    expect(gems.has("rspec-rails")).toBe(true);
    expect(gems.has("factory_bot_rails")).toBe(true);
  });

  it("skips commented-out gem lines (comments are not call nodes)", () => {
    const gemfile = ['gem "devise"', '# gem "cancancan"', '  # gem "draper"'].join("\n");
    const gems = gemfileGemNames(gemfile);
    expect(gems.has("devise")).toBe(true);
    expect(gems.has("cancancan")).toBe(false);
    expect(gems.has("draper")).toBe(false);
  });

  it("returns an empty set for a gem-less or empty Gemfile", () => {
    expect(gemfileGemNames("").size).toBe(0);
    expect(gemfileGemNames('source "https://rubygems.org"\nruby "3.2.0"\n').size).toBe(0);
  });
});
