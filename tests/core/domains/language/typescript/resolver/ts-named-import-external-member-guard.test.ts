import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-vo9gl — the phantom vocabulary.
 *
 * `namedImport` maps an imported receiver to the file that DECLARES it and,
 * when that file indexes no such member, parks a file-only edge onto it. For a
 * receiver that is a project VALUE of a dependency's or the default lib's type,
 * the call never enters that file:
 *
 *   - `<ThemeContext.Provider>` — `Provider` is `React.Context#Provider`,
 *     declared in `@types/react`;
 *   - `useStore.getState()` / `useStore.setState(...)` — zustand's `StoreApi`;
 *   - `ROLES.includes(x)` / `ROLES.slice(1)` — `Array.prototype`, which the
 *     container vocabulary (`ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS`) leaves out
 *     on purpose, since a namespace object may own those names.
 *
 * Measured on taxdome by bd 33lqo: 318 phantom edges of these shapes. The
 * checker names where each member is declared; a member declared only outside
 * the project is no evidence of a module edge, so the park is dropped — and a
 * member the checker declares IN the project keeps it.
 */

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, lines: string[]): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join("\n")}\n`, "utf8");
}

function writeFixture(repoRoot: string): void {
  writeSource(repoRoot, "node_modules/@types/react/package.json", [
    JSON.stringify({ name: "@types/react", version: "18.0.0", types: "index.d.ts" }),
  ]);
  writeSource(repoRoot, "node_modules/@types/react/index.d.ts", [
    "export = React;",
    "export as namespace React;",
    "declare namespace React {",
    "  type ProviderProps<T> = { value: T; children?: unknown };",
    "  type Provider<T> = (props: ProviderProps<T>) => unknown;",
    "  interface Context<T> {",
    "    Provider: Provider<T>;",
    "    Consumer: (props: { children: (value: T) => unknown }) => unknown;",
    "  }",
    "  function createContext<T>(defaultValue: T): Context<T>;",
    "}",
    "declare global {",
    "  namespace JSX {",
    "    interface IntrinsicElements {",
    "      [name: string]: unknown;",
    "    }",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "node_modules/zustand/package.json", [
    JSON.stringify({ name: "zustand", version: "4.0.0", types: "index.d.ts" }),
  ]);
  writeSource(repoRoot, "node_modules/zustand/index.d.ts", [
    "export interface StoreApi<T> {",
    "  getState(): T;",
    "  setState(partial: Partial<T>): void;",
    "}",
    "export type UseBoundStore<S> = (() => unknown) & S;",
    "export declare function create<T>(init: () => T): UseBoundStore<StoreApi<T>>;",
  ]);
  writeSource(repoRoot, "src/theme-context.ts", [
    'import { createContext } from "react";',
    'export const ThemeContext = createContext("light");',
    "export function useTheme(): number {",
    "  return 1;",
    "}",
  ]);
  writeSource(repoRoot, "src/store.ts", [
    'import { create } from "zustand";',
    "export const useStore = create(() => ({ n: 0 }));",
    "export function resetStore(): void {}",
  ]);
  writeSource(repoRoot, "src/constants.ts", [
    'export const ROLES = ["admin", "member"];',
    "export function roleLabel(): string {",
    '  return "";',
    "}",
  ]);
  // A project object literal: `tsNameOf` indexes none of its methods, so the
  // file-only edge is the only edge the chain can give — and it is TRUE.
  writeSource(repoRoot, "src/api.ts", [
    "export const api = {",
    "  getState(id: string): string {",
    "    return id;",
    "  },",
    "};",
  ]);
  // Project namesakes of the dependency members, so a short-name pass further
  // down has something to fabricate an edge onto if the guard lets it.
  writeSource(repoRoot, "src/cache.ts", [
    "export class Cache {",
    "  getState(): number {",
    "    return 0;",
    "  }",
    "  includes(): boolean {",
    "    return false;",
    "  }",
    "}",
  ]);
  writeSource(repoRoot, "src/app.tsx", [
    'import { ThemeContext } from "./theme-context.js";', // 1
    'import { useStore } from "./store.js";', // 2
    'import { ROLES } from "./constants.js";', // 3
    'import { api } from "./api.js";', // 4
    "export function App(role: string): unknown {", // 5
    "  const allowed = ROLES.includes(role);", // 6
    "  const rest = ROLES.slice(1);", // 7
    "  const state = useStore.getState();", // 8
    "  useStore.setState({ n: state.n + 1 });", // 9
    '  const fetched = api.getState("1");', // 10
    '  return <ThemeContext.Provider value="dark">{allowed}{rest}{fetched}</ThemeContext.Provider>;', // 11
    "}",
  ]);
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const table = (): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("src/theme-context.ts", [sym("useTheme", "useTheme", "src/theme-context.ts", [])]);
  t.upsertFile("src/store.ts", [sym("resetStore", "resetStore", "src/store.ts", [])]);
  t.upsertFile("src/constants.ts", [sym("roleLabel", "roleLabel", "src/constants.ts", [])]);
  t.upsertFile("src/api.ts", []);
  t.upsertFile("src/cache.ts", [
    sym("Cache", "Cache", "src/cache.ts", []),
    sym("Cache#getState", "getState", "src/cache.ts", ["Cache"]),
    sym("Cache#includes", "includes", "src/cache.ts", ["Cache"]),
  ]);
  t.upsertFile("src/app.tsx", [sym("App", "App", "src/app.tsx", [])]);
  return t;
};

const ctx = (): CallContext => ({
  callerFile: "src/app.tsx",
  callerScope: ["App"],
  imports: [
    { importText: "./theme-context.js", startLine: 1, importedNames: ["ThemeContext"] },
    { importText: "./store.js", startLine: 2, importedNames: ["useStore"] },
    { importText: "./constants.js", startLine: 3, importedNames: ["ROLES"] },
    { importText: "./api.js", startLine: 4, importedNames: ["api"] },
  ],
  symbolTable: table(),
});

const call = (callText: string, receiver: string, member: string, startLine: number, jsx?: true): CallRef => ({
  callText,
  receiver,
  member,
  startLine,
  ...(jsx ? { jsx } : {}),
});

const INCLUDES = call("ROLES.includes(role)", "ROLES", "includes", 6);
const SLICE = call("ROLES.slice(1)", "ROLES", "slice", 7);
const GET_STATE = call("useStore.getState()", "useStore", "getState", 8);
const SET_STATE = call("useStore.setState({ n: state.n + 1 })", "useStore", "setState", 9);
const PROVIDER = call('<ThemeContext.Provider value="dark">', "ThemeContext", "Provider", 11, true);
const PROJECT_OBJECT_MEMBER = call('api.getState("1")', "api", "getState", 10);

describe("namedImport park on a member declared outside the project (bd tea-rags-mcp-vo9gl)", () => {
  let repoRoot: string;
  let resolver: TSCallResolver;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-vo9gl-")));
    writeFixture(repoRoot);
    resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it.each([
    ["Array#includes on an imported constant", INCLUDES],
    ["Array#slice on an imported constant", SLICE],
    ["zustand StoreApi#getState on an imported store", GET_STATE],
    ["zustand StoreApi#setState on an imported store", SET_STATE],
    ["React Context#Provider on an imported context (JSX tag)", PROVIDER],
  ])("emits no edge for %s, and counts it external", (_label, site) => {
    const c = ctx();
    expect(resolver.resolve(site, c)).toBeNull();
    expect(resolver.targetsExternalImport(site, c)).toBe(true);
  });

  it("keeps the file edge for a member the checker declares in the project (object-literal namespace)", () => {
    expect(resolver.resolve(PROJECT_OBJECT_MEMBER, ctx())).toEqual({
      targetRelPath: "src/api.ts",
      targetSymbolId: null,
    });
  });
});
