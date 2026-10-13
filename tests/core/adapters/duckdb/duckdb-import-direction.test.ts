/**
 * Import-direction pin for adapters/duckdb (bd tea-rags-mcp-89k7k.35, H4a1 +
 * H4a2).
 *
 * The duckdb root owns the daemon contracts the pool consumes — they live in
 * `daemon-ports.ts`, and the daemon classes under `daemon/` implement them and
 * re-export them (child -> parent, the allowed direction). So no file directly
 * in `adapters/duckdb/` may import one of those TYPES from `./daemon/*` — a
 * root type need resolves to `./daemon-ports.js`.
 *
 * Since H4a2 the same holds for VALUES in `pool.ts`: it constructs no daemon
 * class and lazily imports no daemon module — the routing arrives fully built
 * through `GraphDbClientPoolOptions.daemonRouting`. The root -> daemon
 * construction edges are gone entirely; whoever needs them builds a
 * `DaemonRouting` (see `createDaemonRouting` in `daemon/index.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../../../");
const DUCKDB_DIR = join(ROOT, "src/core/adapters/duckdb");
const PORTS_FILE = join(DUCKDB_DIR, "daemon-ports.ts");

/** Types owned by `daemon-ports.ts`, declared there under their post-move names. */
const PORT_TYPES = [
  "CodegraphDaemonPaths",
  "CodegraphDaemonClientAddressing",
  "CodegraphDaemonClientTarget",
  "CodegraphDaemonRestartWiring",
  "ForeignBuildLockArbiter",
  "ForeignBuildLockSettlement",
  "CodegraphDatabaseFileReplacer",
  "DaemonDatabaseReplacement",
  "DaemonCollectionClientCachePort",
  "DaemonRouting",
] as const;

/**
 * Names a duckdb-root file may never TYPE-import from `./daemon/*`: the owned
 * types plus their pre-move aliases (the daemon classes keeping those names
 * are VALUES, importable until H4a2+3 retires their construction).
 */
const DENIED_TYPE_IMPORTS: readonly string[] = [
  ...PORT_TYPES,
  "ForeignBuildDaemonLockArbiter",
  "DaemonDatabaseFileReplacer",
];

/** Every `.ts` file directly in the duckdb root (daemon/ is the child, excluded). */
function rootTsFiles(): string[] {
  return readdirSync(DUCKDB_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(DUCKDB_DIR, entry));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** TYPE bindings of the `from "./daemon/..."` import statements in one file, per statement. */
function daemonTypeImports(file: string): { specifier: string; typeNames: string[] }[] {
  const text = stripComments(readFileSync(file, "utf-8"));
  const statements: { specifier: string; typeNames: string[] }[] = [];
  // `import type { A, B } from` / `import { X, type Y } from` / `import D, { X } from`, multiline included.
  const pattern = /import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*"(\.\/daemon\/[^"]+)"/g;
  for (const match of text.matchAll(pattern)) {
    const statementIsTypeOnly = match[1] !== undefined;
    const typeNames: string[] = [];
    for (const rawBinding of match[2].split(",")) {
      const binding = rawBinding.trim();
      if (!binding) continue;
      const inlineType = binding.startsWith("type ");
      const names = binding.replace(/^type\s+/, "").split(/\s+as\s+/);
      if (statementIsTypeOnly || inlineType) typeNames.push(...names);
    }
    if (typeNames.length > 0) statements.push({ specifier: match[3], typeNames });
  }
  return statements;
}

const rel = (abs: string): string => relative(ROOT, abs);

describe("adapters/duckdb root consumes daemon contracts through daemon-ports", () => {
  it("daemon-ports.ts exists at the duckdb root and names every port type", () => {
    const ports = readFileSync(PORTS_FILE, "utf-8");
    for (const name of PORT_TYPES) {
      expect(ports, `${name} must be declared in daemon-ports.ts`).toMatch(
        new RegExp(`export (?:interface|type) ${name}\\b`),
      );
    }
  });

  it("no duckdb-root file type-imports a port type from ./daemon/*", () => {
    const offenders: string[] = [];
    for (const file of rootTsFiles()) {
      for (const { specifier, typeNames } of daemonTypeImports(file)) {
        for (const name of typeNames) {
          if (DENIED_TYPE_IMPORTS.includes(name)) {
            offenders.push(`${rel(file)} imports type ${name} from ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the single-implementer client-cache port is <Class>Port and its class implements it (bd tea-rags-mcp-89k7k.39)", () => {
    const text = stripComments(readFileSync(join(DUCKDB_DIR, "daemon/collection-client-cache.ts"), "utf-8"));
    expect(text).toMatch(/export class DaemonCollectionClientCache implements DaemonCollectionClientCachePort\b/);
  });

  it("pool.ts has no import from ./daemon/* at all — value or type (H4a2)", () => {
    const text = stripComments(readFileSync(join(DUCKDB_DIR, "pool.ts"), "utf-8"));
    expect(text).not.toMatch(/["']\.\/daemon\//);
  });
});
