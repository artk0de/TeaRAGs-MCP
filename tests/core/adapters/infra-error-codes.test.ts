/**
 * `InfraErrorCode` is the strict union of every code an infrastructure error
 * declares. It drifted once: nine codes — every codegraph daemon error, the
 * DuckDB close failure, the Qdrant dimension guard — were declared by their
 * classes and never added. This reads the codes the classes actually declare
 * from source and holds the union to them both ways, so it cannot drift again.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INFRA_ERROR_CODES } from "../../../src/core/adapters/errors.js";

const SRC = join(import.meta.dirname, "../../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Codes an error class sets: `code: "INFRA_…"` handed to its base constructor,
 * or `Object.defineProperty(this, "code", { value: "INFRA_…" })` on a subclass
 * that narrows its parent's code.
 */
function declaredInfraCodes(): Map<string, string> {
  const declared = new Map<string, string>();
  const patterns = [/\bcode:\s*"(INFRA_[A-Z0-9_]+)"/g, /"code",\s*\{\s*value:\s*"(INFRA_[A-Z0-9_]+)"/g];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) declared.set(match[1], file.slice(SRC.length + 1));
    }
  }
  return declared;
}

describe("InfraErrorCode", () => {
  const declared = declaredInfraCodes();
  const union = new Set<string>(INFRA_ERROR_CODES);

  it("lists every code an infrastructure error class declares", () => {
    const missing = [...declared].filter(([code]) => !union.has(code)).map(([code, file]) => `${code} (${file})`);
    expect(missing).toEqual([]);
  });

  it("lists no code that no error class declares", () => {
    expect(INFRA_ERROR_CODES.filter((code) => !declared.has(code))).toEqual([]);
  });

  it("finds the codegraph daemon codes that once drifted out of it", () => {
    for (const code of [
      "INFRA_CODEGRAPH_CLIENT_STALE_BUILD",
      "INFRA_CODEGRAPH_DAEMON_UNRESPONSIVE",
      "INFRA_CODEGRAPH_DAEMON_REQUEST_ABORTED",
    ]) {
      expect(declared.has(code), code).toBe(true);
    }
  });
});
