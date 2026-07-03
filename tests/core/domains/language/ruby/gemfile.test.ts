import { describe, expect, it } from "vitest";

import { catalogueFor } from "../../../../../src/core/domains/language/ruby/dsl/catalogue.js";
import { catalogueForGemfile, gemfileGemNames } from "../../../../../src/core/domains/language/ruby/gemfile.js";

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

describe("catalogueForGemfile — content-keyed gated catalogue (resolver entry point)", () => {
  it("undefined content → the shared FULL catalogue (no Gemfile → gating off)", () => {
    // Referential identity with catalogueFor(undefined): both are the FULL fallback.
    expect(catalogueForGemfile(undefined)).toBe(catalogueFor(undefined));
  });

  it("a concrete Gemfile parses + composes the base stack (every vocab unconditional today)", () => {
    const cat = catalogueForGemfile('gem "rails"\ngem "sidekiq"\n');
    expect(cat.entries.has_many).toBeDefined(); // rails association macro
    expect(cat.enqueueDispatch.perform_async).toBe("perform"); // sidekiq enqueue verb
    expect(cat.isExternalBareCall("params")).toBe(true); // rails runtime builtin
  });

  it("memoises by the raw content string — same Gemfile yields the same catalogue instance", () => {
    const content = 'gem "rails"\ngem "devise"\n';
    expect(catalogueForGemfile(content)).toBe(catalogueForGemfile(content));
  });

  it("a gem-less Gemfile still yields the unconditional base stack, not an empty catalogue", () => {
    // Parsing finds zero gems, but the unconditional frameworks (rails/ruby-core/
    // activesupport/sidekiq/pundit/routing) always compose in — gating only drops
    // vocabs that carry `activatedBy` (none yet; bd tea-rags-mcp-adx5p.9).
    const cat = catalogueForGemfile('source "https://rubygems.org"\nruby "3.2.0"\n');
    expect(cat.entries.has_many).toBeDefined();
    expect(cat.enqueueDispatch.perform_async).toBe("perform");
  });
});
