import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { LspClient } from "../py-oracle/lsp_oracle.js";
import type { RustInventorySite } from "./rust-codegraph-inventory.js";
import type { RustOracleObservation, RustOracleSourceSite } from "./rust-codegraph-oracle.js";

export interface RustOracleRpc {
  request: (method: string, params: object, timeoutMs: number) => Promise<unknown>;
  notify: (method: string, params: object) => void;
  kill: () => void;
}

export type RustOracleSessionSite = RustInventorySite & { dispatch: "concrete" | "trait"; complete?: boolean };

export interface RustOracleSessionOptions {
  /** Canonical first-party corpus root. No source file is modified. */
  corpusRoot: string;
  /** Explicit absolute executable; this tool never installs/downloads an analyzer. */
  executable: string;
  sites: RustOracleSessionSite[];
  readSource: (path: string) => Promise<string>;
  createClient?: (
    launcher: { command: string[]; settings: Record<string, unknown>; env: NodeJS.ProcessEnv },
    cwd: string,
  ) => RustOracleRpc;
  cargo?: { features?: string[]; target?: string; allTargets?: boolean };
}

export class RustOracleRequestFailure extends Error {
  constructor(readonly kind: "timeout" | "error") {
    super(kind);
  }
}

export interface RustOracleSessionResult {
  status: "ok" | "unsupported" | "error";
  settings: Record<string, unknown>;
  limitations: string[];
  inventoryCount: number;
  observations: RustOracleObservation[];
  skipped: { site: RustOracleSessionSite; reason: string }[];
}

/** The owned transport is Python's already-published LSP client, never another JSON-RPC implementation. */
const defaultClient = (
  launcher: { command: string[]; settings: Record<string, unknown>; env: NodeJS.ProcessEnv },
  cwd: string,
): RustOracleRpc => new LspClient(launcher, cwd);

/**
 * Collect independent definition observations, without inferring token positions or
 * runtime trait targets. An LSP null is an unanswered definition, not a timeout.
 */
export async function collectRustOracleObservations(
  options: RustOracleSessionOptions,
): Promise<RustOracleSessionResult> {
  const root = realpathSync(options.corpusRoot);
  if (!isAbsolute(options.executable)) throw new Error("rust-analyzer executable must be an absolute path");
  const cargo = options.cargo ?? {};
  const settings: Record<string, unknown> = {
    "rust-analyzer": {
      checkOnSave: false,
      cargo: {
        buildScripts: { enable: false },
        ...(cargo.features === undefined ? {} : { features: [...cargo.features] }),
        ...(cargo.target === undefined ? {} : { target: cargo.target }),
        ...(cargo.allTargets === undefined ? {} : { allTargets: cargo.allTargets }),
      },
      procMacro: { enable: false },
      references: { excludeTests: false },
    },
  };
  const limitations = [
    "checkOnSave disabled: no analyzer-triggered Cargo checks on untrusted source",
    "cargo.buildScripts.enable=false: generated build-script code unavailable",
    "procMacro.enable=false: proc-macro expansion unavailable",
    `cargo.features=${cargo.features?.join(",") ?? "analyzerDefault"}`,
    `cargo.target=${cargo.target ?? "analyzerDefault"}`,
    `cargo.allTargets=${String(cargo.allTargets ?? "analyzerDefault")}`,
    "references.excludeTests=false",
    "trait dispatch targets require independent verification; completeness is caller-supplied",
  ];
  const result: RustOracleSessionResult = {
    status: "ok",
    settings,
    limitations,
    inventoryCount: options.sites.length,
    observations: [],
    skipped: [],
  };
  const pending: { site: RustOracleSessionSite; source: RustOracleSourceSite }[] = [];
  for (const site of options.sites) {
    if (!site.tokenRange) {
      result.skipped.push({ site, reason: "missingTokenRange" });
      continue;
    }
    if (
      !site.relPath ||
      isAbsolute(site.relPath) ||
      site.relPath.split("/").some((part) => part === ".." || part === "." || !part)
    ) {
      result.skipped.push({ site, reason: "invalidSourcePath" });
      continue;
    }
    if (site.dispatch !== "concrete" && site.dispatch !== "trait") {
      result.skipped.push({ site, reason: "missingDispatch" });
      continue;
    }
    pending.push({
      site,
      source: {
        relPath: site.relPath,
        expressionRange: site.expressionRange,
        tokenRange: site.tokenRange,
        provenance: site.provenance,
        dispatch: site.dispatch,
      },
    });
  }
  const skipAll = (reason: string): void => {
    result.skipped.push(...pending.map(({ site }) => ({ site, reason })));
  };
  let client: RustOracleRpc | undefined;
  try {
    // LspClient's constructor cannot synchronously report ENOENT from spawn. Probe
    // the explicit binary first and keep the limitation visible in the result.
    if (!options.createClient) accessSync(options.executable, constants.X_OK);
    client = (options.createClient ?? defaultClient)(
      { command: [options.executable], settings, env: { ...process.env } },
      root,
    );
    const rootUri = pathToFileURL(root).href;
    const initialized = await client.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: root.split(sep).at(-1) ?? "corpus" }],
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
          textDocument: { definition: { linkSupport: true }, synchronization: {} },
        },
      },
      120_000,
    );
    if (
      !initialized ||
      typeof initialized !== "object" ||
      !("capabilities" in initialized) ||
      !initialized.capabilities ||
      typeof initialized.capabilities !== "object"
    ) {
      result.status = "unsupported";
      skipAll("unsupportedInitializeResponse");
      return result;
    }
    const capabilities = initialized.capabilities as Record<string, unknown>;
    if (!capabilities.definitionProvider) {
      result.status = "unsupported";
      skipAll("unsupportedDefinitionProvider");
      return result;
    }
    const encoding = capabilities.positionEncoding ?? "utf-16";
    if (encoding !== "utf-16") {
      result.status = "unsupported";
      skipAll("unsupportedPositionEncoding");
      return result;
    }
    client.notify("initialized", {});
    client.notify("workspace/didChangeConfiguration", { settings });
    const documentText = new Map<string, string | null>();
    for (const { site } of pending) {
      if (!documentText.has(site.relPath)) {
        try {
          const absPath = resolve(root, site.relPath);
          // A supplied reader can serve a virtual corpus in tests. The caller
          // owns canonicalization of its inventory paths; never execute source.
          documentText.set(site.relPath, await options.readSource(absPath));
        } catch {
          documentText.set(site.relPath, null);
          limitations.push(`documentUnreadable:${site.relPath}`);
        }
      }
    }
    const visited = new Set<string>();
    for (const { site } of pending) {
      if (visited.has(site.relPath)) continue;
      visited.add(site.relPath);
      const batch = pending.filter((entry) => entry.site.relPath === site.relPath);
      const text = documentText.get(site.relPath);
      if (text === null || text === undefined) {
        for (const entry of batch) {
          result.observations.push({ site: entry.source, response: { kind: "error" }, complete: false });
        }
        continue;
      }
      const uri = pathToFileURL(resolve(root, site.relPath)).href;
      try {
        client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "rust", version: 1, text } });
        for (const entry of batch) {
          try {
            const value = await client.request(
              "textDocument/definition",
              {
                textDocument: { uri },
                position: { ...entry.source.tokenRange.start },
              },
              20_000,
            );
            result.observations.push({
              site: entry.source,
              response: { kind: "success", value },
              complete: value !== null && value !== undefined && entry.site.complete === true,
            });
          } catch (failure) {
            result.observations.push({
              site: entry.source,
              response: { kind: failure instanceof RustOracleRequestFailure ? failure.kind : "error" },
              complete: false,
            });
          }
        }
      } catch {
        for (const entry of batch) {
          if (!result.observations.some((row) => row.site === entry.source)) {
            result.observations.push({ site: entry.source, response: { kind: "error" }, complete: false });
          }
        }
      } finally {
        try {
          client.notify("textDocument/didClose", { textDocument: { uri } });
        } catch {
          limitations.push(`documentCloseFailed:${site.relPath}`);
        }
      }
    }
    // Grouping by file must never reorder the Nth inventory site and Nth answer.
    const order = new Map(pending.map(({ source }, index) => [source, index]));
    result.observations.sort((a, b) => (order.get(a.site) ?? 0) - (order.get(b.site) ?? 0));
    return result;
  } catch {
    result.status = "error";
    skipAll(client ? "rustAnalyzerSessionFailed" : "rustAnalyzerUnavailable");
    return result;
  } finally {
    if (client) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.request("shutdown", {}, 5_000),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new RustOracleRequestFailure("timeout"));
              }, 5_000);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch {
        limitations.push("shutdownFailed");
      } finally {
        try {
          client.notify("exit", {});
        } catch {
          limitations.push("exitFailed");
        } finally {
          client.kill();
        }
      }
    }
  }
}
