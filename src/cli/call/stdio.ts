/** Stdout hygiene for one-shot CLI commands that run the MCP server in-process. */

/**
 * Keep stdout for the tool's answer alone: anything the in-process server
 * logs through `console.log/info/debug` goes to stderr for the duration — the
 * same contract the stdio transport already imposes on the server.
 */
export function routeConsoleToStderr(): () => void {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  return () => {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
  };
}

/** Resolves once everything written to `stream` so far has been flushed. */
export async function flushed(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => {
      resolve();
    });
  });
}
