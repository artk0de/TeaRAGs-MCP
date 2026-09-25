/**
 * Language domain errors — per-language provider construction.
 *
 * Lives in the leaf `domains/language/` domain. Imports only `infra/errors.js`
 * (allowed by the leaf-domain eslint guard, which permits contracts/, infra/,
 * and tree-sitter). Per `.claude/rules/typed-errors.md`: no `throw new Error`.
 */

import { TeaRagsError } from "../../infra/errors.js";

export type LanguageErrorCode = "LANGUAGE_UNSUPPORTED" | "LANGUAGE_GRAMMAR_NOT_INSTALLED";

/**
 * Abstract base for all language-domain errors. Default httpStatus: 500.
 */
export abstract class LanguageError extends TeaRagsError {
  constructor(opts: { code: LanguageErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 500 });
  }
}

/**
 * `LanguageFactoryDescriptor.create(lang)` was called for a language with no registered
 * provider. During the consolidation the factory is a skeleton — no language
 * verticals are wired yet, so every `create` throws this. Once a per-language
 * vertical is registered, `create` returns the provider instead.
 */
export class UnsupportedLanguageError extends LanguageError {
  constructor(lang: string) {
    super({
      code: "LANGUAGE_UNSUPPORTED",
      message: `No language provider registered for "${lang}"`,
      hint: "Per-language providers are wired in their verticals (spec §2, migration step 2). The factory is currently a skeleton with no registered languages.",
    });
  }
}

/**
 * bd tea-rags-mcp-e2pu7 — `LanguageFactory.create(lang)` was asked for a
 * provider whose tree-sitter grammar package (`LanguageKernel.grammarPackage`)
 * does not resolve from this checkout. The typical cause is a checkout one
 * `npm install` short of a `package.json` that gained the grammar — without
 * this check it surfaced as a raw ERR_MODULE_NOT_FOUND resolver trace.
 */
export class GrammarPackageNotInstalledError extends LanguageError {
  constructor(lang: string, grammarPackage: string, cause?: Error) {
    super({
      code: "LANGUAGE_GRAMMAR_NOT_INSTALLED",
      message: `Tree-sitter grammar package "${grammarPackage}" for language "${lang}" is not installed`,
      hint: `Run \`npm install\` in the tea-rags checkout so node_modules matches package.json (it declares ${grammarPackage}), then rebuild.`,
      ...(cause ? { cause } : {}),
    });
  }
}
