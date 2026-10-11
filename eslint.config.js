import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base JS rules
  eslint.configs.recommended,

  // TypeScript type-checked rules
  ...tseslint.configs.recommendedTypeChecked,

  // Parser options for type-aware linting
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── Project rules (informed by bug history analysis) ─────────────
  //
  // Rule severity guide:
  //   "error" = blocks commit (real bugs, auto-fixable issues)
  //   "warn"  = informational (improve incrementally, doesn't block)
  //   "off"   = too noisy or false positives
  //
  {
    rules: {
      // ── Async/Promise (13% of historical bugs) ───────────────────
      // Catches forgotten await, fire-and-forget without void, misused promises
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/promise-function-async": "warn",
      // require-await: off — too many false positives for interface conformance
      "@typescript-eslint/require-await": "off",
      // require-atomic-updates: off — false positives on local variables
      "require-atomic-updates": "off",

      // ── Type safety (16% of historical bugs) ─────────────────────
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/consistent-type-exports": ["error", { fixMixedExportsWithInlineTypeSpecifier: true }],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/prefer-readonly": "warn",

      // ── Logic errors (30% of historical bugs) ────────────────────
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      eqeqeq: ["error", "always"],
      "no-constant-condition": "error",
      "@typescript-eslint/no-unnecessary-condition": "off", // Too many false positives (49 hits)
      "@typescript-eslint/prefer-nullish-coalescing": "off", // 146 hits, many intentional

      // ── Unused code ──────────────────────────────────────────────
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-unreachable": "error",
      "@typescript-eslint/no-unused-expressions": "error",

      // ── Code quality & best practices ────────────────────────────
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-for-of": "warn",
      "@typescript-eslint/prefer-as-const": "error",
      "@typescript-eslint/no-unnecessary-type-parameters": "warn",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/array-type": ["error", { default: "array" }],
      "@typescript-eslint/method-signature-style": ["error", "property"],
      "@typescript-eslint/unbound-method": "warn",
      "no-console": "off", // MCP server — console.error is the log channel

      // ── Error handling ───────────────────────────────────────────
      "@typescript-eslint/only-throw-error": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
      "no-throw-literal": "off", // Superseded by @typescript-eslint/only-throw-error

      // ── Return types & signatures ────────────────────────────────
      "@typescript-eslint/explicit-function-return-type": "off", // TypeScript infers well enough
      "@typescript-eslint/explicit-module-boundary-types": "off", // Same reason
      "@typescript-eslint/no-confusing-void-expression": "warn",

      // ── Inherited from recommendedTypeChecked (calibrated) ───────
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",

      // ── ESLint core best practices ───────────────────────────────
      "no-eval": "error",
      "no-implied-eval": "off", // Superseded by @typescript-eslint/no-implied-eval
      "@typescript-eslint/no-implied-eval": "error",
      "no-new-func": "error",
      "no-param-reassign": "warn",
      "no-return-assign": "error",
      "no-self-compare": "error",
      "no-sequences": "error",
      "no-template-curly-in-string": "warn",
      "no-unmodified-loop-condition": "error",
      "no-useless-concat": "error",
      "prefer-template": "warn",
      "no-else-return": "warn",
      "no-lonely-if": "warn",
      "no-useless-return": "error",
      "object-shorthand": ["warn", "always"],
      "prefer-const": "error",
      "prefer-destructuring": ["warn", { object: true, array: false }],
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "symbol-description": "error",
      curly: ["error", "multi-line"],
    },
  },

  // ── Test files: relax strict rules ───────────────────────────────
  {
    files: ["**/*.test.ts", "tests/**/*.ts", "tests/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "error", // Keep — catches real bugs in tests too
      "@typescript-eslint/no-non-null-assertion": "off", // Common in tests for assertions
      "@typescript-eslint/unbound-method": "off",
      "no-param-reassign": "off", // Acceptable in test setup
      "@typescript-eslint/prefer-readonly": "off",
    },
  },

  // ── Benchmark/script/integration files: minimal rules ───────────
  {
    files: ["benchmarks/**/*.mjs", "scripts/**/*.js", "tests/integration/**/*.mjs"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // ── Dependency direction guard — full layer matrix ──
  // Spec: docs/superpowers/specs/2026-05-27-dependency-direction-guard-design.md
  // Allowed targets per layer (everything else is an error, incl. `import type`):
  //   cli       → bootstrap, core/api/public, core/api/index (assembly surface, bd tea-rags-mcp-89k7k.22)
  //   mcp       → core/api/public
  //   bootstrap → mcp, core/api/*, core/{contracts,primitives,adapters}
  //   index.ts  → bootstrap
  //   api       → core/{domains,contracts,primitives,adapters}
  //   domains/* → core/{contracts,primitives,adapters}  (never each other)
  //   contracts → contracts   primitives → (type-only contracts)
  //   adapters  → core/{contracts,primitives}
  // api/public holds the contract only; runtime classes and the App factory
  // live behind the api root barrel, which cli commands that construct ops
  // with bare clients import as the assembly seam.
  {
    files: ["src/cli/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/core/domains/**",
                "**/core/contracts/**",
                "**/core/adapters/**",
                "**/core/primitives/**",
                "**/core/api/internal/**",
                "**/core/api/errors",
                "**/core/api/errors.js",
                "**/mcp/**",
              ],
              message:
                "cli may import only bootstrap/, core/api/public and the core/api assembly barrel. See .claude/rules/domain-boundaries.md.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/mcp/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/core/domains/**",
                "**/core/contracts/**",
                "**/core/adapters/**",
                "**/core/primitives/**",
                "**/core/api/internal/**",
                "**/core/api/errors",
                "**/core/api/errors.js",
                "**/core/api/index",
                "**/core/api/index.js",
                "**/bootstrap/**",
                "**/cli/**",
              ],
              message: "mcp may import only core/api/public. See .claude/rules/domain-boundaries.md.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/bootstrap/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/cli/**"],
              message: "bootstrap is the composition root; it must not import the cli command layer.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/index.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/**", "**/mcp/**", "**/cli/**"],
              message: "src/index.ts may import only bootstrap/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/api/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/mcp/**", "**/cli/**", "**/bootstrap/**"],
              message: "api/ is the core composition root; it must not import outer layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/domains/explore/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/domains/trajectory/**",
                "**/domains/ingest/**",
                "**/domains/language/**",
                "**/api/**",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
              message: "explore may import only core/{contracts,primitives,adapters}; domains are mutually isolated.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/domains/trajectory/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/domains/explore/**",
                "**/domains/ingest/**",
                "**/domains/language/**",
                "**/language/index.js",
                "**/api/**",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
              message:
                "trajectory may import only core/{contracts,primitives,adapters}; reach language via injected LanguageFactory.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/domains/ingest/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/domains/explore/**",
                "**/domains/trajectory/**",
                "**/domains/language/**",
                "**/language/index.js",
                "**/api/**",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
              message:
                "ingest may import only core/{contracts,primitives,adapters}; reach language via injected LanguageFactory.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/domains/language/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/ingest/**", "**/trajectory/**", "**/explore/**", "**/api/**", "**/bootstrap/**"],
              message: "domains/language is a leaf domain — import only contracts/, primitives/, tree-sitter.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/domains/maintenance/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Bare segment globs (matching the domains/language block) so the
              // guard catches relative sibling/parent specifiers like
              // `../../explore/...` and `../../../api/...`, not only fully
              // qualified `**/domains/explore/**` paths.
              group: [
                "**/explore/**",
                "**/trajectory/**",
                "**/ingest/**",
                "**/language/**",
                "**/api/**",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
              message:
                "maintenance may import only core/{contracts,primitives,adapters}; domains are mutually isolated.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/contracts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Globs are prefix-free on purpose: every import inside src/core is
              // relative ("../primitives/runtime.js"), so a "**/core/..."-anchored
              // pattern never matches and the zone silently allows everything.
              group: [
                "**/primitives/**",
                "**/adapters/**",
                "**/domains/**",
                "**/api/**",
                "**/core/types",
                "**/core/types.js",
                "**/bootstrap/**",
                "**/mcp/**",
                "**/cli/**",
              ],
              message:
                "contracts is pure — no imports from any core/ layer (including the layer-ambiguous core/types.ts root file).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/adapters/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `contracts` is deliberately absent: the layer matrix allows
              // adapters -> contracts, and the old zone only appeared to forbid
              // it because the "**/core/..." glob never fired.
              group: ["**/domains/**", "**/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**"],
              message: "adapters may import only core/{contracts,primitives}.",
            },
          ],
        },
      ],
    },
  },
  // primitives: I/O-free shared code, the lowest runtime layer (bd tea-rags-mcp-2wu2h).
  // `contracts` is absent from the group on purpose — primitives may `import type`
  // from it. no-restricted-imports cannot express "type-only", so the runtime
  // half of that edge, dynamic import()/require() and the I/O globals are pinned
  // by tests/core/primitives/no-io-guard.test.ts. The group never lists the bare
  // `**/infra/**` glob: it would also match domain-local infra/ dirs.
  {
    files: ["src/core/primitives/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            "fs",
            "node:fs",
            "fs/promises",
            "node:fs/promises",
            "child_process",
            "node:child_process",
            "net",
            "node:net",
            "http",
            "node:http",
            "https",
            "node:https",
            "http2",
            "node:http2",
            "dgram",
            "node:dgram",
            "dns",
            "node:dns",
            "tls",
            "node:tls",
            "worker_threads",
            "node:worker_threads",
            "cluster",
            "node:cluster",
            "readline",
            "node:readline",
            "os",
            "node:os",
            "process",
            "node:process",
            "inspector",
            "node:inspector",
            "v8",
            "node:v8",
            "es-git",
            "ollama",
            "undici",
            "node-fetch",
            "simple-git",
          ].map((name) => ({
            name,
            message:
              "primitives are I/O-free; move to adapters/<system> behind a port or to the owning domain (domain-boundaries.md).",
          })),
          patterns: [
            {
              group: ["**/domains/**", "**/adapters/**", "**/api/**", "**/bootstrap/**", "**/mcp/**", "**/cli/**"],
              message: "primitives is the lowest runtime layer — it may only import type from contracts.",
            },
            {
              group: ["@qdrant/*", "@duckdb/*", "duckdb", "duckdb-*"],
              message:
                "primitives are I/O-free; move to adapters/<system> behind a port or to the owning domain (domain-boundaries.md).",
            },
          ],
        },
      ],
    },
  },

  // ── Collection identity brands (bd tea-rags-mcp-39xca.1) ──────────
  // `PhysicalCollectionName` / `CollectionAlias` are minted ONLY in
  // src/core/primitives/ids/collection-identity.ts — by resolving an alias, constructing a
  // new generation, or reading a name back from the storage keyed by it — and,
  // for fixture strings, in the one test helper. A cast anywhere else skips the
  // resolution the brand exists to force.
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    ignores: ["src/core/primitives/ids/collection-identity.ts", "tests/core/__helpers__/collection-identity.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSTypeReference[typeName.name=/^(PhysicalCollectionName|CollectionAlias)$/]",
          message:
            "Do not cast to a collection-identity brand. Mint it in src/core/primitives/ids/collection-identity.ts " +
            "(resolvePhysicalCollection, versionedPhysicalCollectionName, …); tests use " +
            "tests/core/__helpers__/collection-identity.ts.",
        },
        {
          selector: "TSTypeAssertion > TSTypeReference[typeName.name=/^(PhysicalCollectionName|CollectionAlias)$/]",
          message:
            "Do not cast to a collection-identity brand. Mint it in src/core/primitives/ids/collection-identity.ts " +
            "(resolvePhysicalCollection, versionedPhysicalCollectionName, …); tests use " +
            "tests/core/__helpers__/collection-identity.ts.",
        },
      ],
    },
  },

  // ── Ignore patterns ──────────────────────────────────────────────
  {
    ignores: [
      "build/",
      "coverage/",
      "node_modules/",
      "*.d.ts",
      "eslint.config.js", // Root JS config — not in tsconfig
      "commitlint.config.js", // Root JS config — not in tsconfig
      ".claude/worktrees/", // Agent worktrees — isolated copies
      "website/", // Docusaurus — own tsconfig, own build pipeline
    ],
  },
);
