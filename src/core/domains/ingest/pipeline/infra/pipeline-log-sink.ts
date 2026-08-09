/**
 * Where debug log lines land: lazy file creation under the injected logs dir,
 * append-only writes, and the DEBUG gate in front of both.
 *
 * Split out of `debug-logger.ts` so the only filesystem contact in the logger
 * lives behind one small surface — `write` and `getLogPath`. The file is created
 * on the first line that survives the gate, not at construction, so a run with
 * DEBUG off never touches disk and a run that never logs leaves no empty file.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isDebug } from "../../../../infra/runtime.js";
import { readConfigDump, readLogsDir } from "./debug-log-dependencies.js";
import { localTimestamp, renderSessionHeader } from "./debug-log-format.js";

export class PipelineLogSink {
  private logFile: string | null = null;

  /** Append one line, creating the log file on first use. No-op unless DEBUG. */
  write(message: string): void {
    if (!isDebug()) return;
    if (!this.logFile) {
      this.initLogFile();
    }
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, `${message}\n`);
      } catch {
        // Ignore write errors
      }
    }
  }

  /** Path of this session's log file, or null before the first write. */
  getLogPath(): string | null {
    return this.logFile;
  }

  private initLogFile(): void {
    try {
      const logDir = readLogsDir();
      if (!logDir) {
        // No logsDir configured — skip file logging
        return;
      }

      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      const timestamp = localTimestamp();
      this.logFile = join(logDir, `pipeline-${timestamp}.log`);

      // Path is assigned first on purpose: this re-enters write(), which needs
      // logFile set or the header would recurse into init a second time.
      this.write(renderSessionHeader(readConfigDump()));
    } catch (error) {
      console.error("[DebugLogger] Failed to init log file:", error);
    }
  }
}
