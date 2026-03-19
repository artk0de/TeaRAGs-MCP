import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../../src/cli/config/loader.js";

describe("loadConfig", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tea-rags-config-test-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tea-rags-home-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("should return defaults when no config files exist", () => {
    const config = loadConfig({ cwd: tmpDir, homeDir });

    expect(config).toEqual({});
  });

  it("should load project-level .tea-rags/config.yml", () => {
    const configDir = path.join(tmpDir, ".tea-rags");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "config.yml"),
      "embeddingProvider: ollama\nqdrantUrl: http://localhost:6333\n",
    );

    const config = loadConfig({ cwd: tmpDir, homeDir });

    expect(config.embeddingProvider).toBe("ollama");
    expect(config.qdrantUrl).toBe("http://localhost:6333");
  });

  it("should load global ~/.tea-rags/config.yml", () => {
    const configDir = path.join(homeDir, ".tea-rags");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.yml"), "embeddingProvider: onnx\n");

    const config = loadConfig({ cwd: tmpDir, homeDir });

    expect(config.embeddingProvider).toBe("onnx");
  });

  it("should prioritize project config over global config", () => {
    // Global
    const globalDir = path.join(homeDir, ".tea-rags");
    fs.mkdirSync(globalDir);
    fs.writeFileSync(`${globalDir}/config.yml`, "embeddingProvider: onnx\nqdrantUrl: http://global:6333\n");

    // Project
    const projectDir = path.join(tmpDir, ".tea-rags");
    fs.mkdirSync(projectDir);
    fs.writeFileSync(`${projectDir}/config.yml`, "embeddingProvider: ollama\n");

    const config = loadConfig({ cwd: tmpDir, homeDir });

    expect(config.embeddingProvider).toBe("ollama"); // project wins
    expect(config.qdrantUrl).toBe("http://global:6333"); // global fills gaps
  });

  it("should walk up directory tree to find project config", () => {
    // Config at root of project
    const configDir = path.join(tmpDir, ".tea-rags");
    fs.mkdirSync(configDir);
    fs.writeFileSync(`${configDir}/config.yml`, "embeddingProvider: ollama\n");

    // cwd is a nested subdirectory
    const nested = path.join(tmpDir, "src", "deep", "nested");
    fs.mkdirSync(nested, { recursive: true });

    const config = loadConfig({ cwd: nested, homeDir });

    expect(config.embeddingProvider).toBe("ollama");
  });

  it("should stop walking at filesystem root", () => {
    const config = loadConfig({ cwd: "/tmp/nonexistent/deep/path", homeDir });

    expect(config).toEqual({});
  });

  it("should handle malformed YAML gracefully", () => {
    const configDir = path.join(tmpDir, ".tea-rags");
    fs.mkdirSync(configDir);
    fs.writeFileSync(`${configDir}/config.yml`, "{{invalid yaml: [}");

    expect(() => loadConfig({ cwd: tmpDir, homeDir })).not.toThrow();
    const config = loadConfig({ cwd: tmpDir, homeDir });
    expect(config).toEqual({});
  });

  it("should ignore non-object YAML content", () => {
    const configDir = path.join(tmpDir, ".tea-rags");
    fs.mkdirSync(configDir);
    fs.writeFileSync(`${configDir}/config.yml`, "just a string\n");

    const config = loadConfig({ cwd: tmpDir, homeDir });

    expect(config).toEqual({});
  });
});
