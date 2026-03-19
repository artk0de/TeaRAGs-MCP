#!/usr/bin/env node
import { createCli } from "./create-cli.js";

createCli()
  .parseAsync()
  .catch((error: unknown) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
