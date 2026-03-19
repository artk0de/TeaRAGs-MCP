import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "yaml";

export interface LoadConfigOptions {
  cwd?: string;
  homeDir?: string;
}

/**
 * Load and merge tea-rags config from YAML files.
 *
 * Priority (highest to lowest):
 * 1. .tea-rags/config.yml (project-level, walking up from cwd)
 * 2. ~/.tea-rags/config.yml (global)
 */
export function loadConfig(options?: LoadConfigOptions): Record<string, unknown> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? os.homedir();

  const globalConfig = readYamlConfig(path.join(home, ".tea-rags", "config.yml"));
  const projectConfig = findProjectConfig(cwd);

  return { ...globalConfig, ...projectConfig };
}

function findProjectConfig(startDir: string): Record<string, unknown> {
  let dir = startDir;

  while (true) {
    const configPath = path.join(dir, ".tea-rags", "config.yml");
    const config = readYamlConfig(configPath);
    if (config !== null) {
      return config;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return {};
}

function readYamlConfig(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = parse(content);

    if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}
