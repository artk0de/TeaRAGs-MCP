/**
 * TypeScript import-path mapper used by `TSCallResolver`.
 *
 * Slice-1 depth: relative paths + tsconfig `compilerOptions.paths` /
 * `baseUrl`. Bare npm specifiers (no relative prefix and no alias match)
 * are returned as `null` — graph edges for node_modules dependencies
 * are out of scope until Slice 3.
 */

import { posix } from "node:path";

export interface TsCompilerOptions {
  baseUrl: string;
  paths: Record<string, string[]>;
}

export function mapImportToFile(importText: string, callerFile: string, options: TsCompilerOptions): string | null {
  if (importText.startsWith(".")) {
    const dir = posix.dirname(callerFile);
    const joined = posix.normalize(posix.join(dir, importText));
    return appendTsExtension(joined);
  }
  for (const [pattern, targets] of Object.entries(options.paths)) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "@/"
      if (importText.startsWith(prefix)) {
        const suffix = importText.slice(prefix.length);
        const target = targets[0]?.replace("/*", `/${suffix}`);
        if (!target) return null;
        return appendTsExtension(posix.normalize(posix.join(options.baseUrl, target)));
      }
    } else if (pattern === importText) {
      const target = targets[0];
      if (!target) return null;
      return appendTsExtension(posix.normalize(posix.join(options.baseUrl, target)));
    }
  }
  return null;
}

function appendTsExtension(path: string): string {
  if (path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".js") || path.endsWith(".jsx")) {
    return path;
  }
  return `${path}.ts`;
}
