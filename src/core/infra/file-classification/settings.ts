/**
 * The file classifier's operator knobs, as the composition root hands them
 * down (bd tea-rags-mcp-82ztq).
 *
 * The classifier reads no environment: `TEA_RAGS_GENERATED_PATTERNS` and
 * `TEA_RAGS_MINIFIED_LINE_THRESHOLD` are parsed by bootstrap config
 * (`fileClassificationSchema`) and installed here by `createAppContext`, the
 * same install-once-per-isolate shape `./test-file-conventions.ts` uses for
 * the language test shapes. Unlike those, nothing installed is a legitimate
 * state, not a wiring bug: the defaults ARE the unset-env behaviour, so a
 * worker isolate or a test that never installs answers exactly as an operator
 * who set neither variable.
 *
 * Explicit callers can bypass the installed value — `isCompiledJsContent`
 * takes the threshold as an optional argument.
 */

/** Default longest-line length above which JS content is treated as minified. */
export const DEFAULT_MINIFIED_LINE_LENGTH = 50_000;

export interface FileClassificationSettings {
  /** Extra gitignore globs classified as generated, appended to `GENERATED_PATTERNS`. */
  readonly userGeneratedPatterns: readonly string[];
  /** Longest-line length above which JS-family content is treated as minified. */
  readonly minifiedLineLength: number;
}

export const DEFAULT_FILE_CLASSIFICATION_SETTINGS: FileClassificationSettings = Object.freeze({
  userGeneratedPatterns: Object.freeze([]),
  minifiedLineLength: DEFAULT_MINIFIED_LINE_LENGTH,
});

let installed: FileClassificationSettings = DEFAULT_FILE_CLASSIFICATION_SETTINGS;

/**
 * Install the settings every module-level reader of this isolate answers from.
 * A later install replaces the earlier one (readers key their caches on the
 * installed object).
 */
export function installFileClassificationSettings(settings: FileClassificationSettings): void {
  installed = settings;
}

/** The installed settings — {@link DEFAULT_FILE_CLASSIFICATION_SETTINGS} until a composition root installs any. */
export function installedFileClassificationSettings(): FileClassificationSettings {
  return installed;
}
