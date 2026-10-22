/**
 * Builds the one `RustAnalyzerInstallHintLookup` every surface shares — the
 * index run, `prime` and `get_index_status` (bd s3i8m.6). The lookup lives in
 * bootstrap because it binds config (`codegraph.rustAnalyzer`) to the
 * rust-analyzer adapter; domains and the api layer receive it injected.
 */

import {
  createRustAnalyzerResolver,
  defaultRustAnalyzerDiscoveryDeps,
  discoverRustAnalyzer,
  RUST_ANALYZER_PATH_ENV,
  rustAnalyzerInstallHintFor,
  type RustAnalyzerDiscoveryDeps,
  type RustAnalyzerExecutable,
  type RustAnalyzerInstallHintLookup,
} from "../core/adapters/rust-analyzer/index.js";

/** The slice of the resolved config the lookup reads. */
export interface RustAnalyzerInstallHintConfig {
  codegraph?: {
    enabled: boolean;
    rustAnalyzer: { enabled: boolean; path?: string | undefined };
  };
}

/**
 * Null when codegraph or the rust-analyzer slot is off: a project that opted
 * out of the slot must not be nagged to install it. Otherwise discovery runs
 * lazily, only for an index holding Rust, memoized per project root, with the
 * configured `path` standing in for `CODEGRAPH_RUST_ANALYZER_PATH`.
 */
export function createRustAnalyzerInstallHintLookup(
  config: RustAnalyzerInstallHintConfig,
  discover: (deps: RustAnalyzerDiscoveryDeps) => RustAnalyzerExecutable | null = discoverRustAnalyzer,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
): RustAnalyzerInstallHintLookup | null {
  const { codegraph } = config;
  if (!codegraph?.enabled || !codegraph.rustAnalyzer.enabled) return null;
  const env = codegraph.rustAnalyzer.path
    ? { ...baseEnv, [RUST_ANALYZER_PATH_ENV]: codegraph.rustAnalyzer.path }
    : baseEnv;
  const resolve = createRustAnalyzerResolver((projectRoot) =>
    discover(defaultRustAnalyzerDiscoveryDeps(projectRoot, env)),
  );
  return ({ path, languages }) => rustAnalyzerInstallHintFor(languages, () => resolve(path));
}
