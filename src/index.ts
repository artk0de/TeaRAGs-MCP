#!/usr/bin/env node
import { runMcpServer } from "./bootstrap/transport/server-runtime.js";

runMcpServer({}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
