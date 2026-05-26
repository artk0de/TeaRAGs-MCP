/**
 * Zeitwerk constant → file resolution.
 *
 * Zeitwerk's convention is:
 *   - Each constant lives in a file whose path matches the
 *     snake_case'd version of the constant chain.
 *   - Acronyms uppercase in the constant become lowercase in the path
 *     (User → user, HTMLParser → html_parser, RDocFormatter → r_doc_formatter).
 *   - Namespaces become directories (Acme::Auth::User → acme/auth/user.rb).
 *   - The autoload root is configurable but typically `app/...` for
 *     Rails or `lib/...` for gems; rather than hard-coding either, the
 *     resolver tries multiple roots in order and picks the first that
 *     matches a known file in the symbol table.
 */

const DEFAULT_AUTOLOAD_ROOTS = ["app/models", "app/controllers", "app/services", "app/jobs", "app", "lib"];

/**
 * Convert a Ruby constant chain ("Acme::Auth::User") into the relative
 * file path Zeitwerk would expect for the constant's definition.
 *
 * Returns just the suffix WITHOUT a root prefix. Callers prepend the
 * autoload root they want to try ("app/models/", "lib/", etc.).
 */
export function constantToFilePath(qualified: string): string {
  return `${qualified.split("::").map(snakeCase).join("/")}.rb`;
}

/**
 * Active Support–style underscore for Zeitwerk: CamelCase → snake_case,
 * preserving consecutive uppercase as a single boundary.
 *
 *   User           → user
 *   HTMLParser     → html_parser
 *   RDocFormatter  → r_doc_formatter
 *   APIController  → api_controller
 *   V2Endpoint     → v2_endpoint     (digit-after-letter joins)
 */
export function snakeCase(name: string): string {
  // Insert an underscore between:
  //   - a lowercase letter or digit and an uppercase letter (`User` → unchanged, `userName` → `user_Name`)
  //   - a run of uppercase letters followed by an uppercase+lowercase pair
  //     (`HTMLParser` → `HTML_Parser`)
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Given a Zeitwerk constant chain and the list of every file path
 * known to the symbol table (or the on-disk walker output), return
 * the first matching file path, or null if none match.
 *
 * Tries `<root>/<snake_case_path>` for each default root, then falls
 * back to a basename match — any indexed file whose basename equals
 * the constant's last segment in snake_case.
 */
export function resolveZeitwerkConstant(qualified: string, knownPaths: Iterable<string>): string | null {
  const suffix = constantToFilePath(qualified);
  const paths = new Set(knownPaths);
  for (const root of DEFAULT_AUTOLOAD_ROOTS) {
    const candidate = `${root}/${suffix}`;
    if (paths.has(candidate)) return candidate;
  }
  // Basename fallback — any path ending in `/<suffix>` or just `<suffix>`.
  for (const p of paths) {
    if (p === suffix) return p;
    if (p.endsWith(`/${suffix}`)) return p;
  }
  return null;
}
