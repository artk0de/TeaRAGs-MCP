/**
 * Every git child tea-rags spawns runs under the git child env contract (bd
 * tea-rags-mcp-s5kpv): `buildGitChildProcessEnv` from `infra/git-executable.ts`
 * turns git's OPTIONAL locks off, so no read in the user's tree takes
 * `index.lock`. A spawn site that forgets it reintroduces the stale-lock bug
 * silently — nothing else fails — so this guard reads the source.
 *
 * It parses `src/` with the TypeScript compiler, so formatting cannot fool it.
 * A git spawn is a call whose COMMAND argument is `resolveGitExecutable()` (or
 * a local bound to it): the one way tea-rags names the git binary. Such a call
 * passes, when either
 *  - its options literal carries `env: buildGitChildProcessEnv(...)`, or
 *  - its callee is one of the git spawn helpers below, which apply the
 *    contract themselves — and the guard checks that they do.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

const GIT_EXECUTABLE_RESOLVER = "resolveGitExecutable";
const GIT_CHILD_ENV_BUILDER = "buildGitChildProcessEnv";

/** Helper → file declaring it. Each spawns ONLY git and applies the env contract inside. */
const GIT_SPAWN_HELPERS: Readonly<Record<string, string>> = {
  execWithStallGuard: "src/core/adapters/vcs/git/git-cli/stall-guard-exec.ts",
  execFileAsync: "src/core/adapters/vcs/git/git-cli/client.ts",
};

/** The node:child_process primitives a helper may wrap. */
const CHILD_PROCESS_PRIMITIVES = new Set(["spawn", "execFile", "execFileSync", "spawnSync"]);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return callee.getText();
}

function isCallTo(node: ts.Node | undefined, name: string): boolean {
  return node !== undefined && ts.isCallExpression(node) && calleeName(node) === name;
}

/** True iff some object-literal argument carries `env: buildGitChildProcessEnv(...)`. */
function passesGitChildEnv(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (arg) =>
      ts.isObjectLiteralExpression(arg) &&
      arg.properties.some(
        (prop) =>
          ts.isPropertyAssignment(prop) &&
          prop.name.getText() === "env" &&
          isCallTo(prop.initializer, GIT_CHILD_ENV_BUILDER),
      ),
  );
}

interface GitSpawnSite {
  location: string;
  callee: string;
  ok: boolean;
}

function findGitSpawnSites(sourceFile: ts.SourceFile): GitSpawnSite[] {
  const gitLocals = new Set<string>();
  walk(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isCallTo(node.initializer, GIT_EXECUTABLE_RESOLVER)
    ) {
      gitLocals.add(node.name.text);
    }
  });
  const sites: GitSpawnSite[] = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const command = node.arguments[0];
    const namesGit =
      isCallTo(command, GIT_EXECUTABLE_RESOLVER) ||
      (command !== undefined && ts.isIdentifier(command) && gitLocals.has(command.text));
    if (!namesGit) return;
    const callee = calleeName(node);
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    sites.push({
      location: `${relative(ROOT, sourceFile.fileName)}:${String(line + 1)}`,
      callee,
      ok: callee in GIT_SPAWN_HELPERS || passesGitChildEnv(node),
    });
  });
  return sites;
}

describe("git child env guard (bd tea-rags-mcp-s5kpv)", () => {
  const sites = listSourceFiles(SRC).flatMap((path) => findGitSpawnSites(parse(path)));

  it("finds the git spawn sites (the scan is not vacuous)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("every git spawn runs under buildGitChildProcessEnv", () => {
    const offenders = sites.filter((site) => !site.ok).map((site) => `${site.location} (${site.callee})`);
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(GIT_SPAWN_HELPERS))("helper %s applies the env contract to its child", (helper, file) => {
    const sourceFile = parse(join(ROOT, file));
    let declaration: ts.FunctionDeclaration | undefined;
    walk(sourceFile, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === helper) declaration = node;
    });
    expect(declaration, `${helper} is declared in ${file}`).toBeDefined();

    const spawns: ts.CallExpression[] = [];
    walk(declaration as ts.Node, (node) => {
      if (ts.isCallExpression(node) && CHILD_PROCESS_PRIMITIVES.has(calleeName(node))) spawns.push(node);
    });
    expect(spawns.length).toBeGreaterThan(0);
    expect(spawns.every(passesGitChildEnv)).toBe(true);
  });
});
