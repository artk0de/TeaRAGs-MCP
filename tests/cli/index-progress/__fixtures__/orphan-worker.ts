/**
 * Child process for `parent-death-guard.test.ts` — a stand-in index worker.
 *
 * Forked the way `index-codebase` forks its worker (detached, IPC), it starts a
 * grandchild in its own process group — the git / chunker children a real
 * worker has — reports that pid to its supervisor, and stays alive until
 * something kills it.
 *
 *   argv[2] = "guarded"      install the guard at once, as the worker does
 *   argv[2] = "after-parent" install it only once the parent is already gone:
 *                            the supervisor died before the worker got there
 */

import { spawn } from "node:child_process";

import { installParentDeathGuard } from "../../../../src/cli/index-progress/parent-death-guard.js";

const mode = process.argv[2];
const grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
process.send?.({ grandchild: grandchild.pid });
setInterval(() => undefined, 1000);

const install = (): void => {
  installParentDeathGuard(process, {
    onOrphaned: () => {
      process.kill(-process.pid, "SIGKILL");
    },
  });
};

if (mode === "after-parent") {
  const waitForParentToGo = setInterval(() => {
    if (process.connected) return;
    clearInterval(waitForParentToGo);
    install();
  }, 20);
} else {
  install();
}
