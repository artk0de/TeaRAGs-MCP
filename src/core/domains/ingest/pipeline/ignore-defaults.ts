/**
 * Built-in ignore patterns applied by FileScanner BEFORE user .gitignore/
 * .contextignore. Covers framework build artefacts, language caches, IDE
 * configs, and minified bundles that are universally undesirable for
 * semantic search/indexing.
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
];
