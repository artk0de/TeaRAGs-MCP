/**
 * Built-in ignore patterns applied by FileScanner BEFORE user .gitignore/
 * .contextignore. Covers framework build artefacts, language caches, IDE
 * configs, minified bundles, and data/serialization formats (json/yaml —
 * fixtures, cassettes, config) that are universally undesirable for
 * semantic search/indexing. Signal-bearing JSON manifests (package.json,
 * tsconfig.json, *.config.json, …) are re-included via negation; YAML is
 * fully ignored. Users override either way via .contextignore.
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

  // Ruby
  ".bundle/",
  "vendor/bundle/",

  // Java/Kotlin (Maven/Gradle)
  "target/",
  ".gradle/",

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

  // Compiled / vendored JS asset locations. These dirs hold readable-but-
  // compiled bundles (Rails vendored libs like vendor/assets/javascripts/d3.js,
  // sprockets/webpacker output, JS build dirs) that blow the tree-sitter parse
  // budget and pollute a code RAG. Narrow on purpose — only the asset dirs, NOT
  // a bare `**/vendor/**` (general vendored code is handled by the classifier's
  // enrichment-skip, not by dropping it from the index). Users re-include via a
  // `.contextignore` `!pattern`.
  "**/vendor/assets/**",
  "public/assets/**",
  "public/packs/**",
  "dist/**",

  // Data / serialization formats (not code — fixtures, VCR cassettes, CI/config).
  // A code RAG should not embed recorded HTTP responses or config blobs. Keep
  // signal-bearing JSON manifests via negation; YAML is fully ignored.
  "*.json",
  "*.yaml",
  "*.yml",
  "!package.json",
  "!tsconfig.json",
  "!tsconfig.*.json",
  "!*.config.json",
  "!composer.json",
  "!deno.json",
];
