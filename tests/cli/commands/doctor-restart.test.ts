/**
 * `tea-rags doctor --restart` — the command's own contract (bd
 * tea-rags-mcp-42hno): which flags reach the restart orchestration and what
 * the operator — or an agent reading `--json` — is told about every keyed
 * daemon. The orchestration itself is pinned in
 * `tests/bootstrap/codegraph-daemon-restart.test.ts`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CodegraphDaemonRestartOutcome } from "../../../src/bootstrap/codegraph-daemon-restart.js";
import {
  doctorCommand,
  runDaemonRestartDoctor,
  type DaemonRestartDoctorDeps,
} from "../../../src/cli/commands/doctor.js";

let out: string;
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  out = "";
  origWrite = process.stdout.write;
  process.stdout.write = (chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  };
});

afterEach(() => {
  process.stdout.write = origWrite;
});

function depsWith(outcomes: CodegraphDaemonRestartOutcome[]): DaemonRestartDoctorDeps {
  return { storageDir: mkdtempSync(join(tmpdir(), "doctor-restart-")), outcomes };
}

describe("runDaemonRestartDoctor (42hno)", () => {
  it("reports each stopped daemon with its key directory", async () => {
    await runDaemonRestartDoctor({}, depsWith([{ keyDir: "/d/b-aaaaaaaa", pid: 4242, action: "stopped" }]));
    expect(out).toMatch(/\[OK\].*pid 4242.*stopped.*\/d\/b-aaaaaaaa/s);
    expect(out).toMatch(/Restarted 1 codegraph daemon/i);
  });

  it("reports swept orphans and exit timeouts distinctly", async () => {
    await runDaemonRestartDoctor(
      {},
      depsWith([
        { keyDir: "/d/b-bbbbbbbb", action: "swept" },
        { keyDir: "/d/b-cccccccc", pid: 7, action: "exit-timeout" },
      ]),
    );
    expect(out).toMatch(/swept.*b-bbbbbbbb/s);
    expect(out).toMatch(/\[WARN\].*did not exit.*b-cccccccc/s);
    expect(out).toMatch(/Restarted 0 codegraph daemon/i);
    expect(out).toMatch(/swept 1 orphaned key director/i);
  });

  it("says so when no keyed daemon is live", async () => {
    await runDaemonRestartDoctor({}, depsWith([]));
    expect(out).toMatch(/[Nn]o (live )?build-keyed codegraph daemon/i);
  });

  it("--json emits the structured outcome list", async () => {
    await runDaemonRestartDoctor({ json: true }, depsWith([{ keyDir: "/d/b-dddddddd", pid: 9, action: "stopped" }]));
    const parsed = JSON.parse(out) as { storageDir: string; daemons: CodegraphDaemonRestartOutcome[] };
    expect(parsed.daemons).toEqual([{ keyDir: "/d/b-dddddddd", pid: 9, action: "stopped" }]);
  });

  it("the doctor command routes --restart to the restart doctor", async () => {
    await doctorCommand.handler({ restart: true, json: false, _: [], $0: "tea-rags" });
    // Default deps against the sandboxed data dir: no keyed daemons exist.
    expect(out).toMatch(/[Nn]o (live )?build-keyed codegraph daemon/i);
  });
});
