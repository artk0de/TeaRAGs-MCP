/**
 * Synthetic TypeScript/React corpus generator for the codegraph resolve-path
 * profiles (bd tea-rags-mcp-d77bl).
 *
 * The real project this exists to model is not available offline, so the shapes
 * here are borrowed rather than invented: the ambiguous receiver comes from
 * `ts-type-checker-fallback.test.ts`'s generic-factory fixture, the JSX
 * component reference from `ts-type-checker-jsx-component.test.ts`, and the
 * explicit-type-argument call from the same fallback suite's `generic`
 * classification case.
 *
 * What the generator is really reproducing is the IMPORT TOPOLOGY, because that
 * is what a per-entry-file `ts.Program` pays for. A feature directory exports
 * through a barrel, and one cross-feature import of that barrel pulls the whole
 * feature in — so barrels are the knob that decides whether a file's transitive
 * closure is a handful of files or the entire corpus.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FixtureShape {
  /** Feature directories generated. */
  features: number;
  /** Components (`.tsx`) per feature. */
  componentsPerFeature: number;
  /** Cross-feature barrel imports each feature makes. */
  crossFeatureImports: number;
  /**
   * Route cross-feature imports through the feature BARREL (`@features/fNN`)
   * rather than the specific module. True is the React-app default and the
   * reason closures explode; false isolates the effect.
   */
  useBarrels: boolean;
}

export const DEFAULT_SHAPE: FixtureShape = {
  features: 40,
  componentsPerFeature: 6,
  crossFeatureImports: 3,
  useBarrels: true,
};

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const featureName = (i: number): string => `f${String(i).padStart(3, "0")}`;

/**
 * Shared leaf layer every feature imports. Deliberately import-free so it can
 * never be the thing that inflates a closure — a corpus where even the leaves
 * pull neighbours in cannot distinguish topology cost from file count.
 */
function writeShared(root: string): void {
  write(
    root,
    "src/shared/types.ts",
    ["export interface Config {", "  readonly id: string;", "  readonly retries: number;", "}", ""].join("\n"),
  );
  write(
    root,
    "src/shared/format.ts",
    ["export function formatLabel(value: string): string {", "  return value.trim();", "}", ""].join("\n"),
  );
  write(
    root,
    "src/shared/decode.ts",
    [
      `import type { Config } from "./types.js";`,
      "",
      "export function decode<T>(raw: string): T {",
      "  return JSON.parse(raw) as T;",
      "}",
      "",
      "export function defaultConfig(): Config {",
      `  return { id: "0", retries: 3 };`,
      "}",
      "",
    ].join("\n"),
  );
  // The generic factory whose return type only the checker can name — the
  // mechanism behind the fallback suite's inferred-receiver fixture.
  write(
    root,
    "src/shared/make.ts",
    ["export function make<T>(factory: () => T): T {", "  return factory();", "}", ""].join("\n"),
  );
  write(
    root,
    "src/shared/index.ts",
    [
      `export * from "./types.js";`,
      `export * from "./format.js";`,
      `export * from "./decode.js";`,
      `export * from "./make.js";`,
      "",
    ].join("\n"),
  );
}

/**
 * One feature: a repository class, an API module, a hook, N components, and a
 * barrel.
 *
 * Every feature declares a `fetch` method on its repository, which is what
 * makes the member ambiguous corpus-wide — `classifyTypeCheckerFallbackCase`
 * routes a call to the checker precisely when the short name is declared on
 * more than one type, so a one-repository corpus would never exercise the
 * fallback at all.
 */
function writeFeature(root: string, index: number, shape: FixtureShape): void {
  const name = featureName(index);
  const dir = `src/features/${name}`;

  write(
    root,
    `${dir}/repo.ts`,
    [
      `import type { Config } from "@shared/types";`,
      "",
      `export class ${name.toUpperCase()}Repo {`,
      "  fetch(id: string): string {",
      "    return id;",
      "  }",
      "",
      "  save(config: Config): boolean {",
      "    return config.retries > 0;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );

  // Cross-feature edges. Through the barrel these drag the neighbour's whole
  // feature into any Program rooted here; through the specific module they drag
  // one file.
  const neighbours: string[] = [];
  for (let k = 1; k <= shape.crossFeatureImports; k++) {
    const target = (index + k * 7) % shape.features;
    if (target !== index) neighbours.push(featureName(target));
  }
  const neighbourImports = neighbours
    .map((n) =>
      shape.useBarrels
        ? `import { ${n.toUpperCase()}Repo } from "@features/${n}";`
        : `import { ${n.toUpperCase()}Repo } from "@features/${n}/repo";`,
    )
    .join("\n");

  write(
    root,
    `${dir}/api.ts`,
    [
      `import { decode, make } from "@shared/index";`,
      `import type { Config } from "@shared/types";`,
      `import { ${name.toUpperCase()}Repo } from "./repo.js";`,
      neighbourImports,
      "",
      // Inferred receiver: `repo` is typed only by the generic factory's return,
      // and `fetch` is declared on every feature's repository, so no tree-sitter
      // pass can pin it. This is the fallback suite's shape.
      `export function load${name.toUpperCase()}(id: string): string {`,
      `  const repo = make(() => new ${name.toUpperCase()}Repo());`,
      "  return repo.fetch(id);",
      "}",
      "",
      // Explicit type arguments — the `generic` classification.
      `export function parse${name.toUpperCase()}(raw: string): Config {`,
      "  return decode<Config>(raw);",
      "}",
      "",
      ...neighbours.map((n) =>
        [
          `export function bridge${n.toUpperCase()}(id: string): string {`,
          `  const other = make(() => new ${n.toUpperCase()}Repo());`,
          "  return other.fetch(id);",
          "}",
          "",
        ].join("\n"),
      ),
    ].join("\n"),
  );

  write(
    root,
    `${dir}/hooks.ts`,
    [
      `import { formatLabel } from "@shared/format";`,
      `import { load${name.toUpperCase()} } from "./api.js";`,
      "",
      `export function use${name.toUpperCase()}(id: string): string {`,
      `  return formatLabel(load${name.toUpperCase()}(id));`,
      "}",
      "",
    ].join("\n"),
  );

  for (let c = 0; c < shape.componentsPerFeature; c++) {
    const component = `${name.toUpperCase()}View${c}`;
    const child = c > 0 ? `${name.toUpperCase()}View${c - 1}` : null;
    write(
      root,
      `${dir}/components/${component}.tsx`,
      [
        `import { use${name.toUpperCase()} } from "../hooks.js";`,
        child ? `import { ${child} } from "./${child}.js";` : "",
        "",
        `export function ${component}(props: { id: string }): unknown {`,
        `  const label = use${name.toUpperCase()}(props.id);`,
        // JSX component reference — resolvable only by the checker's JSX pass.
        child ? `  return <${child} id={label} />;` : "  return label;",
        "}",
        "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
  }

  const componentExports = Array.from(
    { length: shape.componentsPerFeature },
    (_, c) => `export * from "./components/${name.toUpperCase()}View${c}.js";`,
  );
  write(
    root,
    `${dir}/index.ts`,
    [
      `export * from "./repo.js";`,
      `export * from "./api.js";`,
      `export * from "./hooks.js";`,
      ...componentExports,
      "",
    ].join("\n"),
  );
}

/** Generate the corpus at `root`, replacing whatever was there. Returns file count. */
export function generateFixture(root: string, shape: FixtureShape = DEFAULT_SHAPE): number {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  writeShared(root);
  for (let i = 0; i < shape.features; i++) writeFeature(root, i, shape);

  write(
    root,
    "tsconfig.json",
    `${JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          jsx: "preserve",
          module: "esnext",
          moduleResolution: "bundler",
          target: "es2022",
          paths: {
            "@shared/*": ["src/shared/*"],
            "@features/*": ["src/features/*"],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  // shared (5) + per feature: repo, api, hooks, index, components
  return 5 + shape.features * (4 + shape.componentsPerFeature);
}
