#!/usr/bin/env node
const argv = process.argv.slice(2);

/**
 * `project indexed` is the lean path (bd tea-rags-mcp-ueplg): the plugin's
 * PreToolUse(Read) hook runs it on every `Read`, and loading yargs plus the
 * whole command table costs ~0.5 s. `--help` still goes through yargs.
 */
const isLeanProjectIndexed =
  argv[0] === "project" && argv[1] === "indexed" && !argv.includes("--help") && !argv.includes("-h");
const isLeanPrimeAgent =
  argv[0] === "prime" &&
  argv.includes("--agent") &&
  !argv.includes("--full") &&
  !argv.includes("--help") &&
  !argv.includes("-h");

async function main(): Promise<void> {
  if (isLeanPrimeAgent) {
    const { runPrimeAgentArgv } = await import("./commands/prime-agent.js");
    process.exitCode = await runPrimeAgentArgv(argv.slice(1));
    return;
  }
  if (isLeanProjectIndexed) {
    const { runProjectIndexedArgv } = await import("./commands/project-indexed.js");
    process.exitCode = await runProjectIndexedArgv(argv.slice(2));
    return;
  }
  const { createCli } = await import("./create-cli.js");
  await createCli().parseAsync();
}

main().catch((error: unknown) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
