import { describe, expect, it } from "vitest";

import { RUBY_CODEGRAPH_EXCLUSION_GLOBS } from "../../../../../src/core/domains/language/ruby/codegraph-exclusions.js";
import { RubyLanguage } from "../../../../../src/core/domains/language/ruby/index.js";

/**
 * bd tea-rags-mcp-biwbq — Rails non-application-code path globs are Ruby-language
 * knowledge and live in the Ruby language domain (mirrors how walker/resolver
 * capabilities live in `domains/language/ruby`). The generic codegraph exclusion
 * engine aggregates them per-language; it hardcodes no `db/` or `ruby` knowledge.
 */
describe("RUBY_CODEGRAPH_EXCLUSION_GLOBS", () => {
  it("is the single source listing the Rails non-app-code path globs", () => {
    expect(RUBY_CODEGRAPH_EXCLUSION_GLOBS).toEqual([
      "**/db/migrate/**",
      "**/db/post_migrate/**",
      "**/db/data/**",
      "**/db/schema.rb",
      "**/db/data_schema.rb",
    ]);
  });

  it("covers the hand-written procedural-schema directories that create recall holes", () => {
    // db/migrate + db/data are hand-written schema ops on an untyped ORM builder
    // (`t.datetime` on receiver `t`) — not application call-graph.
    expect(RUBY_CODEGRAPH_EXCLUSION_GLOBS).toContain("**/db/migrate/**");
    expect(RUBY_CODEGRAPH_EXCLUSION_GLOBS).toContain("**/db/data/**");
  });

  it("covers post-deployment migrations, the second migration directory Rails apps split out", () => {
    // bd tea-rags-mcp-7s39j — `db/post_migrate` is the post-deployment half of
    // the same procedural schema DSL (Mastodon, GitLab). Same untyped builder
    // receivers, same recall hole; it was simply missing from the sibling list.
    expect(RUBY_CODEGRAPH_EXCLUSION_GLOBS).toContain("**/db/post_migrate/**");
  });
});

describe("RubyLanguage codegraph-exclusion capability", () => {
  it("exposes the ruby-domain exclusion globs via the LanguageProvider surface", () => {
    // Same reference as the single-source constant — no per-instance copy.
    expect(new RubyLanguage().codegraphExclusionGlobs).toBe(RUBY_CODEGRAPH_EXCLUSION_GLOBS);
  });
});
