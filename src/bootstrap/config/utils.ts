import { z } from "zod";

export interface DeprecationNotice {
  oldName: string;
  newName: string;
}

export function envWithFallback(
  deprecations: DeprecationNotice[],
  newName: string,
  ...oldNames: string[]
): string | undefined {
  const newVal = process.env[newName];
  if (newVal !== undefined && newVal !== "") return newVal;
  for (const old of oldNames) {
    const oldVal = process.env[old];
    if (oldVal !== undefined && oldVal !== "") {
      deprecations.push({ oldName: old, newName });
      return oldVal;
    }
  }
  return undefined;
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
