/**
 * Configuration and constants for code vectorization
 */

export const DEFAULT_CODE_EXTENSIONS = [
  // TypeScript/JavaScript
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  // Python
  ".py",
  // Go
  ".go",
  // Rust
  ".rs",
  // Java/Kotlin
  ".java",
  ".kt",
  // C/C++
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cc",
  ".cxx",
  // C#
  ".cs",
  // Ruby
  ".rb",
  // PHP
  ".php",
  // Swift
  ".swift",
  // Dart
  ".dart",
  // Scala
  ".scala",
  // Clojure
  ".clj",
  ".cljs",
  // Haskell
  ".hs",
  // OCaml
  ".ml",
  // Shell
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  // SQL/Data
  ".sql",
  ".proto",
  ".graphql",
  // Web
  ".vue",
  ".svelte",
  // Config/Markup
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
];

export const DEFAULT_IGNORE_PATTERNS = [
  "node_modules/**",
  "dist/**",
  "build/**",
  "out/**",
  "target/**",
  "coverage/**",
  ".nyc_output/**",
  ".cache/**",
  "__pycache__/**",
  ".git/**",
  ".svn/**",
  ".hg/**",
  ".vscode/**",
  ".idea/**",
  "*.min.js",
  "*.min.css",
  "*.bundle.js",
  "*.map",
  "*.log",
  ".env",
  ".env.*",
];

export const DEFAULT_CHUNK_SIZE = 2500;
export const DEFAULT_CHUNK_OVERLAP = 300;
export const DEFAULT_BATCH_SIZE = 100;
