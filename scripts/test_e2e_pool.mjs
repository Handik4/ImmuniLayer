#!/usr/bin/env node
/**
 * ImmuniLayer E2E entrypoint (`npm run e2e`).
 *
 * Orchestrates the browser UI test (e2e-browser-pool.mjs): headless Chromium loads
 * the real frontend, fills the Create Pool form and clicks submit so the app's own
 * handleCreatePool runs against studio-next. No direct genlayer-js contract calls
 * are made from this script.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "e2e-browser-pool.mjs")], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
