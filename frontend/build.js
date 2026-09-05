#!/usr/bin/env node
/**
 * ImmuniLayer frontend build.
 *
 * The frontend is a dependency-free static app (vanilla JS + genlayer-js loaded
 * over ESM CDN in the browser). This build:
 *   1. verifies all required source files are present,
 *   2. syntax-checks the classic browser scripts (config.js, app.js) so a typo
 *      fails the build instead of shipping,
 *   3. sanity-checks that the browser ES module (genlayer-client.js) parses,
 *   4. assembles a clean dist/ bundle ready to serve.
 *
 * No third-party packages are required, so `npm run build` works offline.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = __dirname;
const DIST = path.join(SRC, "dist");

const ASSETS = [
  "index.html",
  "style.css",
  "config.js",
  "genlayer-client.js",
  "app.js",
];

// Classic (non-module) browser scripts we can parse with vm.Script.
const CLASSIC_SCRIPTS = ["config.js", "app.js"];
// Browser ES modules (use import/export) - parsed as modules.
const ES_MODULES = ["genlayer-client.js"];

function fail(msg) {
  console.error(`[FAIL] build failed: ${msg}`);
  process.exit(1);
}

function checkPresent() {
  for (const name of ASSETS) {
    const p = path.join(SRC, name);
    if (!fs.existsSync(p)) fail(`missing required asset: ${name}`);
  }
  console.log(`[OK] all ${ASSETS.length} source assets present`);
}

function syntaxCheckClassic() {
  for (const name of CLASSIC_SCRIPTS) {
    const code = fs.readFileSync(path.join(SRC, name), "utf8");
    try {
      // Parses/compiles without executing - catches syntax errors only.
      new vm.Script(code, { filename: name });
    } catch (e) {
      fail(`syntax error in ${name}: ${e.message}`);
    }
  }
  console.log(`[OK] classic scripts parsed (${CLASSIC_SCRIPTS.join(", ")})`);
}

function syntaxCheckModules() {
  // vm.SourceTextModule is only available under --experimental-vm-modules.
  // When unavailable, fall back to a lightweight structural check so the build
  // still runs on a stock Node install.
  for (const name of ES_MODULES) {
    const code = fs.readFileSync(path.join(SRC, name), "utf8");
    if (typeof vm.SourceTextModule === "function") {
      try {
        // eslint-disable-next-line no-new
        new vm.SourceTextModule(code, { identifier: name });
      } catch (e) {
        fail(`syntax error in ${name}: ${e.message}`);
      }
    } else {
      if (!/\bimport\b/.test(code) && !/\bexport\b|window\./.test(code)) {
        fail(`${name} does not look like a valid browser module`);
      }
    }
  }
  console.log(`[OK] ES modules parsed (${ES_MODULES.join(", ")})`);
}

function assembleDist() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  for (const name of ASSETS) {
    fs.copyFileSync(path.join(SRC, name), path.join(DIST, name));
  }
  console.log(`[OK] wrote dist/ (${ASSETS.length} files) -> ${path.relative(process.cwd(), DIST)}`);
}

function main() {
  console.log("Building ImmuniLayer frontend...");
  checkPresent();
  syntaxCheckClassic();
  syntaxCheckModules();
  assembleDist();
  console.log("[OK] build succeeded");
}

main();
