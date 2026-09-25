import { describe, expect, it } from "vitest";

import {
  emphasiseChangelogVocabulary,
  LANGUAGE_AND_FRAMEWORK_TERMS,
  PROJECT_TERMS,
} from "../../scripts/lib/changelog-emphasis.js";

// Bullets lifted verbatim from CHANGELOG.md — the transform has to survive the
// prose the generator actually produces, not a synthetic sentence. Each one
// carries something the pass must refuse to touch: an inline code span, a
// possessive right after a term, or a term the reader's own code is written in.
const V1_43_0_TYPESCRIPT_BULLET =
  "TypeScript and JavaScript code search and navigation resolve calls and imports " +
  "far more accurately: `this`-member calls, interface implementations, and calls " +
  "into base classes outside the project are now correctly attributed";

const V1_43_0_QDRANT_BULLET =
  "`prime` now shows how much RAM and page cache an index is using against " +
  "Qdrant's total, with a detailed memory breakdown available in debug mode";

describe("emphasiseChangelogVocabulary — emphasis tiers", () => {
  it("wraps a language or framework name in bold italic", () => {
    expect(emphasiseChangelogVocabulary("Ruby call-graph navigation improved")).toContain("***Ruby***");
  });

  it("wraps a project term in bold", () => {
    expect(emphasiseChangelogVocabulary("an index is using against Qdrant's total")).toContain("**Qdrant**'s");
  });

  it("gives the two tiers different markers so a reader can tell them apart", () => {
    const out = emphasiseChangelogVocabulary("Ruby call-graph navigation improved");
    expect(out).toContain("***Ruby***");
    expect(out).toContain("**call-graph**");
    expect(out).not.toContain("***call-graph***");
  });

  it("emphasises every occurrence in the sentence, not just the first", () => {
    const out = emphasiseChangelogVocabulary("Python resolution and Python imports");
    expect(out.match(/\*\*\*Python\*\*\*/g)).toHaveLength(2);
  });

  it("leaves prose with no vocabulary in it byte-identical", () => {
    const plain = "Search results now honor small limits exactly";
    expect(emphasiseChangelogVocabulary(plain)).toBe(plain);
  });
});

describe("emphasiseChangelogVocabulary — inline code spans", () => {
  it("leaves a term inside an inline code span untouched", () => {
    const out = emphasiseChangelogVocabulary("the `rank_chunks` tool and the `Ruby` walker");
    expect(out).toContain("`Ruby`");
    expect(out).not.toContain("`***Ruby***`");
    expect(out).not.toContain("***Ruby***");
  });

  it("leaves a term inside a double-backtick span untouched", () => {
    const out = emphasiseChangelogVocabulary("spelled ``Go`` in the docs");
    expect(out).toBe("spelled ``Go`` in the docs");
  });

  it("still emphasises a term that sits outside the code span in the same sentence", () => {
    const out = emphasiseChangelogVocabulary(V1_43_0_TYPESCRIPT_BULLET);
    expect(out).toContain("***TypeScript*** and ***JavaScript***");
    expect(out).toContain("`this`-member calls");
  });
});

describe("emphasiseChangelogVocabulary — markdown links", () => {
  it("leaves a term in a link label untouched", () => {
    const out = emphasiseChangelogVocabulary("see [the Ruby guide](https://example.com/guide)");
    expect(out).toContain("[the Ruby guide]");
    expect(out).not.toContain("***Ruby***");
  });

  it("leaves a term in a link URL untouched", () => {
    const out = emphasiseChangelogVocabulary("see [the guide](https://example.com/MCP/Ruby)");
    expect(out).toContain("(https://example.com/MCP/Ruby)");
    expect(out).not.toContain("**MCP**");
  });

  it("leaves a term in a bare URL untouched", () => {
    const out = emphasiseChangelogVocabulary("published at https://artk0de.github.io/TeaRAGs-MCP/blog");
    expect(out).toBe("published at https://artk0de.github.io/TeaRAGs-MCP/blog");
  });
});

describe("emphasiseChangelogVocabulary — already emphasised", () => {
  it.each(["*Ruby*", "**Ruby**", "***Ruby***"])("leaves %s alone rather than nesting more markers", (wrapped) => {
    expect(emphasiseChangelogVocabulary(`a ${wrapped} change`)).toBe(`a ${wrapped} change`);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const first = emphasiseChangelogVocabulary(V1_43_0_TYPESCRIPT_BULLET);
    expect(emphasiseChangelogVocabulary(first)).toBe(first); // idempotent
  });

  it("is idempotent on a bullet mixing a code span, a possessive and a project term", () => {
    const first = emphasiseChangelogVocabulary(V1_43_0_QDRANT_BULLET);
    expect(emphasiseChangelogVocabulary(first)).toBe(first); // idempotent
  });
});

describe("emphasiseChangelogVocabulary — longest match first", () => {
  it("emphasises Ruby on Rails as one term instead of Ruby plus Rails", () => {
    const out = emphasiseChangelogVocabulary("resolution for Ruby on Rails applications");
    expect(out).toContain("***Ruby on Rails***");
    expect(out).not.toContain("***Ruby*** on ***Rails***");
  });

  it("does not depend on the declaration order of the vocabulary arrays", () => {
    // Rails is declared before Ruby on Rails in the source list; the match still
    // has to prefer the longer spelling.
    expect(LANGUAGE_AND_FRAMEWORK_TERMS.indexOf("Rails")).toBeLessThan(
      LANGUAGE_AND_FRAMEWORK_TERMS.indexOf("Ruby on Rails"),
    );
    expect(emphasiseChangelogVocabulary("Ruby on Rails")).toBe("***Ruby on Rails***");
  });
});

describe("emphasiseChangelogVocabulary — case sensitivity", () => {
  it.each([
    ["go to the docs for details", "Go"],
    ["a swift response from the daemon", "Swift"],
    ["users react to the change", "React"],
    ["the python script is unrelated", "Python"],
  ])("does not emphasise %s on the strength of %s", (sentence) => {
    expect(emphasiseChangelogVocabulary(sentence)).toBe(sentence);
  });

  it("matches a declared casing alias, since sentence-initial spellings are real prose", () => {
    expect(emphasiseChangelogVocabulary("Call-graph completeness improved")).toContain("**Call-graph**");
  });
});

describe("emphasiseChangelogVocabulary — word boundaries", () => {
  it("does not emphasise Java inside JavaScript", () => {
    const out = emphasiseChangelogVocabulary("JavaScript test files are now chunked");
    expect(out).toContain("***JavaScript***");
    expect(out).not.toContain("***Java***Script");
  });

  it("does not emphasise Go inside a longer word", () => {
    const out = emphasiseChangelogVocabulary("a Gopher-flavoured Django model manager");
    expect(out).toContain("Gopher-flavoured");
    expect(out).not.toContain("***Go***pher");
  });

  it("does not emphasise SQL inside SQLAlchemy", () => {
    const out = emphasiseChangelogVocabulary("Django model managers and SQLAlchemy models");
    expect(out).toContain("***SQLAlchemy***");
    expect(out).not.toContain("***SQL***Alchemy");
  });
});

describe("LANGUAGE_AND_FRAMEWORK_TERMS / PROJECT_TERMS", () => {
  it("share no term between the two vocabularies — an overlap is a bug, not a precedence question", () => {
    const shared = LANGUAGE_AND_FRAMEWORK_TERMS.filter((term: string) => PROJECT_TERMS.includes(term));
    expect(shared).toEqual([]);
  });

  it("declare no term twice inside its own vocabulary", () => {
    for (const vocabulary of [LANGUAGE_AND_FRAMEWORK_TERMS, PROJECT_TERMS]) {
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });

  // The matcher guards every term with \b, which only anchors against a word
  // character — a term that began or ended with punctuation would silently stop
  // matching. Pin the precondition here rather than defending it at runtime.
  it("declare every term with a word character at both ends, which is what \\b anchors against", () => {
    const offenders = [...LANGUAGE_AND_FRAMEWORK_TERMS, ...PROJECT_TERMS].filter(
      (term: string) => !/^\w/.test(term) || !/\w$/.test(term),
    );
    expect(offenders).toEqual([]);
  });
});
