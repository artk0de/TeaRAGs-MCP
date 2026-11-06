import type { IgnoredDirectoryMarker } from "../../../contracts/types/ingest-config.js";

/**
 * Built-in ignore patterns applied by FileScanner BEFORE user .gitignore/
 * .contextignore. Covers framework build artefacts, language caches, IDE
 * configs, minified bundles, and data/serialization formats (json/yaml —
 * fixtures, cassettes, config) that are universally undesirable for
 * semantic search/indexing. Signal-bearing JSON manifests (package.json,
 * tsconfig.json, *.config.json, …) are re-included via negation, and so is
 * YAML under `config/` and `.github/` (Rails/app config, CI workflows — bd
 * tea-rags-mcp-q1g6s.7) except `config/locales/` (i18n strings, the bulk of
 * config YAML bytes). Users override either way via .contextignore.
 *
 * Patterns follow .gitignore syntax — directory names with trailing slash
 * match anywhere in tree; glob patterns like `*.min.js` work via the
 * `ignore` npm package.
 *
 * Users can override any of these via explicit `!pattern` in their own
 * .contextignore (ignore-package supports negations).
 */
export const BUILTIN_IGNORE_PATTERNS: string[] = [
  // JS/Node build artefacts
  "node_modules/",
  ".next/",
  ".nuxt/",
  "_nuxt/",
  ".svelte-kit/",
  ".vite/",
  ".parcel-cache/",
  ".turbo/",
  "out/",
  ".cache/",

  // Python
  "__pycache__/",
  "*.pyc",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".nox/",
  "htmlcov/",
  "*.egg-info/",
  ".venv/",
  "venv/",

  // Ruby gems and Go module copies. `vendor/` is the whole third-party tree
  // (Go modules, Ruby gems), not project source. A trailing slash matches a
  // directory of that name anywhere, so the walker does not descend into it.
  ".bundle/",
  "vendor/",

  // Java/Kotlin/Scala build output (Maven, sbt). Cargo uses the same name but
  // declares it itself (`domains/language/rust/ingest-ignore.ts`) — this entry
  // is not Rust's, and dropping it would not un-ignore a Cargo `target/`.
  "target/",
  ".gradle/",

  // Swift / Xcode. Unlike most build output these are DIRECTORIES OF REAL
  // `.swift` SOURCE, not opaque binaries: SwiftPM materializes every
  // dependency into `.build/checkouts/`, and CocoaPods does the same under
  // `Pods/`. Indexing them copies every dependency's symbols into the graph,
  // so a small app reads as a monorepo and its own code loses rank. The
  // project's `Sources/`, `Tests/` and `Package.swift` are deliberately NOT
  // matched here — Swift test chunking reads `Tests/`.
  // `*.xcodeproj` / `*.xcworkspace` are directory packages holding generated
  // project state (`project.pbxproj`, per-user `xcuserdata`), never source.
  ".build/",
  ".swiftpm/",
  "DerivedData/",
  "*.xcodeproj/",
  "*.xcworkspace/",
  "xcuserdata/",
  "Pods/",
  "Carthage/Build/",
  // Compiled bundles — directory packages with a binary payload.
  "*.framework/",
  "*.xcframework/",
  "*.dSYM/",
  "*.xcarchive/",

  // Generic VCS / IDE
  ".git/",
  ".svn/",
  ".hg/",
  ".DS_Store",
  "*.log",
  "coverage/",
  ".idea/",
  ".vscode/",

  // Minified bundles
  "*.min.js",
  "*.min.css",
  "*.bundle.js",
  "*-min.js",
  "*-bundle.js",
  "*.chunk.js",

  // Compiled JS asset locations. These dirs hold readable-but-compiled
  // bundles (sprockets/webpacker output, JS build dirs) that blow the
  // tree-sitter parse budget. `vendor/` itself is excluded above. Users
  // re-include via a `.contextignore` `!pattern`.
  "**/vendor/assets/**",
  "public/assets/**",
  "public/packs/**",
  "dist/**",

  // Data / serialization formats (not code — fixtures, VCR cassettes, CI/config).
  // A code RAG should not embed recorded HTTP responses or config blobs. Keep
  // signal-bearing JSON manifests and config/CI YAML via negation; locales
  // come LAST so they win over the config re-include.
  "*.json",
  "*.yaml",
  "*.yml",
  "!**/config/**/*.yml",
  "!**/config/**/*.yaml",
  "!.github/**/*.yml",
  "!.github/**/*.yaml",
  "!package.json",
  "!tsconfig.json",
  "!tsconfig.*.json",
  "!*.config.json",
  "!composer.json",
  "!deno.json",
  "**/config/locales/",
];

/**
 * Built-in, language-agnostic directories recognised by their contents (see
 * `IgnoredDirectoryMarker`): vendored suites whose location is a project's
 * choice, so no path pattern finds them and no name is safe to ignore.
 *
 * The web-platform-tests suite, vendored by browser engines (servo keeps it at
 * `tests/wpt/tests`, ~67k admitted files — 97% of the tree). Its root carries the
 * `wpt` launcher, `lint.ignore` and the `resources/testharness.js` harness; a
 * directory merely named `wpt`, or an engine's own test directory beside the
 * suite carrying one `lint.ignore`, holds not all three.
 */
export const BUILTIN_IGNORED_DIRECTORY_MARKERS: readonly IgnoredDirectoryMarker[] = [
  {
    reason: "vendored upstream web-platform-tests suite",
    entries: ["wpt", "lint.ignore", "resources/testharness.js"],
  },
];
