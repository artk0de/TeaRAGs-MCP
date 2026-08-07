import { z } from "zod";

export interface DeprecationNotice {
  oldName: string;
  newName: string;
}

/** Where config values are read from. Defaults to the process env everywhere. */
export type EnvSource = NodeJS.ProcessEnv | Record<string, string>;

/** Reads one alias family (canonical name first, then deprecated spellings). */
export type EnvReader = (newName: string, ...oldNames: string[]) => string | undefined;

function readEnv(
  source: EnvSource,
  deprecations: DeprecationNotice[],
  newName: string,
  oldNames: string[],
): string | undefined {
  const newVal = source[newName];
  if (newVal !== undefined && newVal !== "") return newVal;
  for (const old of oldNames) {
    const oldVal = source[old];
    if (oldVal !== undefined && oldVal !== "") {
      deprecations.push({ oldName: old, newName });
      return oldVal;
    }
  }
  return undefined;
}

/**
 * Bind an alias-family reader to one env source. The MCP server parses a
 * request-scoped config from a per-project env MAP rather than from the global
 * — reading process.env there would make concurrent index runs race
 * (tea-rags-mcp-pmfm4).
 */
export function createEnvReader(deprecations: DeprecationNotice[], source: EnvSource = process.env): EnvReader {
  return (newName, ...oldNames) => readEnv(source, deprecations, newName, oldNames);
}

export function envWithFallback(
  deprecations: DeprecationNotice[],
  newName: string,
  ...oldNames: string[]
): string | undefined {
  return readEnv(process.env, deprecations, newName, oldNames);
}

/** Parse "true"/"1" -> true, everything else -> false */
export const booleanFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Parse string to int, returning undefined for absent/empty values */
export const optionalInt = z
  .string()
  .optional()
  .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : undefined))
  .pipe(z.number().int().optional());

/** Parse string to int with a default */
export function intWithDefault(defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : defaultValue))
    .pipe(z.number().int());
}

/** Parse string to float with a default */
export function floatWithDefault(defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((v) => (v !== undefined && v !== "" ? parseFloat(v) : defaultValue))
    .pipe(z.number());
}

/** Parse "true"/"1" -> true, everything else -> defaultValue */
export function booleanFromEnvWithDefault(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return defaultValue;
      return v === "true" || v === "1";
    });
}

/** Parse string to positive int (optional) */
export const optionalPositiveInt = z
  .string()
  .optional()
  .transform((v) => (v !== undefined && v !== "" ? parseInt(v, 10) : undefined))
  .pipe(z.number().int().positive().optional());
