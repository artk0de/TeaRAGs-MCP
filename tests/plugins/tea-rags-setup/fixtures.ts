import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins/tea-rags-setup/scripts");

export interface ScriptRun {
  status: number;
  json: Record<string, unknown>;
}

export function runScript(
  script: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): ScriptRun {
  const fullEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete fullEnv[key];
  try {
    const stdout = execFileSync(process.execPath, [join(SCRIPTS_DIR, script), ...args], {
      env: fullEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, json: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string };
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(failed.stdout ?? "") as Record<string, unknown>;
    } catch {
      /* no JSON on stdout */
    }
    return { status: failed.status ?? 1, json };
  }
}

/** Create a git repo in a tmp dir; `files` maps relative path -> content. All are committed. */
export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tea-rags-setup-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  git("add", "-A", "-f");
  git("commit", "-q", "-m", "init");
  return dir;
}
