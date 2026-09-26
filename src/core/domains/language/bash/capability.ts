import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "bash",
  ast: { tier: "full", engine: "tree-sitter", grammarPackage: "tree-sitter-bash" },
  tests: { tier: "low", detection: "—", tech: "generic AST (bats/shunit not recognized)" },
  codegraph: {
    tier: "minimal",
    tech: "function-call extraction only, no dispatch",
    // Kind roles (bd tea-rags-mcp-jqvbn, spec §1a).
    // Bash declares functions and nothing else.
    symbolKindRoles: {
      callee: new Set(["function"]),
      receiver: new Set(["function"]),
    },
  },
  // codegraphSchema 2: bd tea-rags-mcp-ex28m — see typescript/capability.ts.
  // chunking 2: bd tea-rags-mcp-lyo4p — a top-level `command` chunk no longer
  // takes its callee's name as its symbolId.
  // walker 2: bd tea-rags-mcp-4p3sb.6 — the walker publishes
  // `identifierDeclarations` (a function's assignments, `local` / `declare`
  // names, loop variables) for the naming lexicon. Rows written by walker 1
  // carry none, so only the recompute adds them.
  // walker 2: release v1.44.2 shipped walker 1 and a release cycle gets ONE
  // walker bump, so every branch-local number above collapses into 2.
  versions: { chunking: 2, walker: 2, codegraphSchema: 2 },
  // Google Shell Style Guide: functions and variables lower snake_case,
  // constants and exported environment variables SCREAMING_SNAKE. Bash has no
  // types, modules or fields; those roles take the variable casing so the
  // record stays total.
  naming: {
    casing: {
      type: ["snake"],
      module: ["snake"],
      method: ["snake"],
      param: ["snake"],
      local: ["snake"],
      field: ["snake"],
      constant: ["screamingSnake"],
    },
    // Bash has no type annotations, so no type name ever reaches the lexicon.
    nonConceptTypes: [],
  },
};
