// scripts/lib/changelog-emphasis.js
// Emphasis pass over release-note prose, consumed by lib/render-changelog.js.
//
// WHICH words carry emphasis is a rendering decision, not a writing one, so it
// belongs here rather than in scripts/release-changelog-prompt.md. A prompt
// rule produces markdown nobody can verify: the model would emphasise a term in
// one release and miss it in the next, and the only way to notice is to read the
// published notes. A transform is a pure function over the generated JSON —
// pinned by tests, identical across releases, and reviewable as a diff.
//
// The vocabularies below are curated against what CHANGELOG.md actually says.
// Every spelling is declared explicitly: sentence-initial capitals and plurals
// are entries of their own, because inferring them would mean case-folding, and
// case-folding is how `Go` starts matching "go to the docs".

// Languages, frameworks and test frameworks the READER'S OWN code is written in
// or built with. Rendered bold + italic, the heavier marker, because "does this
// release touch my stack?" is the first question someone scans a changelog for.
//
// The language list mirrors src/core/domains/language/<lang>/ — a language
// tea-rags indexes will eventually get a release note. The framework list is
// what the notes have actually named by hand.
export const LANGUAGE_AND_FRAMEWORK_TERMS = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Ruby",
  "Go",
  "Java",
  "Rust",
  "Swift",
  "Bash",
  "Markdown",
  // Not an indexed language, but named in prose as a file kind the call-graph
  // analyzer skips ("like JSON, Markdown, SQL, or TOML").
  "SQL",
  "Rails",
  // Declared AFTER "Rails" on purpose — matching is longest-first, not
  // array-order, and this is the pair that proves it.
  "Ruby on Rails",
  "ActiveRecord",
  "Django",
  "SQLAlchemy",
  "React",
  "RSpec",
  "XCTest",
  // The corpus spells the pair as one unit. Bare "Quick" is deliberately absent:
  // its canonical spelling is indistinguishable from a sentence-initial
  // adjective, and the only honest fix would be inferring case, which this
  // module refuses to do.
  "Quick/Nimble",
  "YARD",
];

// tea-rags' own vocabulary, plus the third-party runtimes a user operates
// alongside it. Rendered bold: these name the machinery, not the reader's code.
export const PROJECT_TERMS = [
  "TeaRAGs",
  "MCP",
  "Qdrant",
  "Ollama",
  "call-graph",
  "Call-graph",
  "code-graph",
  "Code-graph",
  "codegraph",
  "ranking preset",
  "Ranking presets",
  "enrichment",
  "enrichments",
  "worktree",
  "worktrees",
  "Worktree",
];

const LANGUAGE_AND_FRAMEWORK_MARKER = "***";
const PROJECT_MARKER = "**";

const MARKER_BY_TERM = new Map([
  ...LANGUAGE_AND_FRAMEWORK_TERMS.map((term) => [term, LANGUAGE_AND_FRAMEWORK_MARKER]),
  ...PROJECT_TERMS.map((term) => [term, PROJECT_MARKER]),
]);

function escapeForPattern(term) {
  return term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Longest spelling first, so `Ruby on Rails` beats `Ruby`, and `worktrees` beats
// `worktree` (which would otherwise leave a dangling `**worktree**s`). A JS
// alternation is first-match-wins at each position, so the sort IS the rule —
// array order carries no meaning.
const VOCABULARY_PATTERN = new RegExp(
  `\\b(?:${[...MARKER_BY_TERM.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeForPattern)
    .join("|")})\\b`,
  "g",
);

// Spans the pass refuses to enter, in the order they must be tried:
//   1. code spans — `rank_chunks` is an identifier, and emphasis inside
//      backticks renders as literal asterisks. Double-backtick form first, or
//      the single-backtick alternative would match its empty interior.
//   2. markdown links — neither the label nor the href is prose.
//   3. bare URLs — the compare and blog links carry the product name.
//   4. existing emphasis — a term already wrapped is left alone, which is also
//      what makes the whole pass idempotent: its own output is span 4.
const PROTECTED_SPAN =
  /``[^`]*``|`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*/g;

function emphasiseSegment(segment) {
  return segment.replace(VOCABULARY_PATTERN, (term) => {
    const marker = MARKER_BY_TERM.get(term);
    return `${marker}${term}${marker}`;
  });
}

// Emphasise known vocabulary in one description, leaving protected spans byte-
// identical. Compose it AFTER escapeMentions: that pass is the one that inserts
// backticks, and this one treats backticks as a wall, so mentions escaped first
// are safe. The other order breaks the mention escape outright — `@Rails` would
// become `@***Rails***`, which escapeMentions no longer recognises, and GitHub
// would autolink a phantom account.
export function emphasiseChangelogVocabulary(text) {
  let emphasised = "";
  let cursor = 0;
  PROTECTED_SPAN.lastIndex = 0;
  for (let span = PROTECTED_SPAN.exec(text); span !== null; span = PROTECTED_SPAN.exec(text)) {
    emphasised += emphasiseSegment(text.slice(cursor, span.index)) + span[0];
    cursor = span.index + span[0].length;
  }
  return emphasised + emphasiseSegment(text.slice(cursor));
}
