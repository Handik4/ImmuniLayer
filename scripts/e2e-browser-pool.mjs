#!/usr/bin/env node
/**
 * ImmuniLayer browser UI E2E: drives the real frontend (headless Chromium) through
 * the Create Pool form and asserts that `handleCreatePool` (frontend/app.js) runs
 * and creates a pool on the live GenLayer Studio Next contract.
 *
 * What is real: the static frontend, genlayer-js running in the page, the DOM form
 * (#newPoolName, #newPoolRepo, ...), the submit-button click, and the on-chain tx
 * against studio-next (Chain ID 61997) at the address in frontend/config.js.
 * What is mocked: only the browser wallet. A EIP-1193 provider is injected as
 * window.ethereum (and announced via EIP-6963). It reports a connected account and
 * forwards RPC calls; eth_sendTransaction is signed by an ephemeral key held by this
 * Node process (the role MetaMask's signer normally plays) and broadcast to studio-next.
 *
 * Usage: cd scripts && npm install && npm run test:e2e:ui
 * Env:   HEADED=1 to watch the browser; SCREENSHOT_DIR to change the output dir.
 */
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const RPC = "https://studio-next.genlayer.com/api";
const CHAIN_ID = 61997;
const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(here, "..", "frontend");
const SHOTS = process.env.SCREENSHOT_DIR || join(here, "e2e-artifacts");
const TX_TIMEOUT_MS = 240_000;

const POOL = {
  name: `E2E UI Pool ${Date.now()}`,
  repo: "https://github.com/Handik4/ImmuniLayer",
  desc: "Automated browser E2E: router, verifiers and liquidity pool contracts in scope.",
  deposit: "10",
  critical: "5",
  high: "2",
  medium: "1",
  low: "0.2"
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) throw new Error(`assertion failed: ${name}`);
};

const rpc = async (method, params) => {
  const r = await (await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
  })).json();
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.result;
};

// ---- static server for frontend/ -------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(FRONTEND, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;

// ---- mock wallet account (signs in Node) -----------------------------------
const account = privateKeyToAccount(generatePrivateKey());
const signAndSend = async (tx) => {
  const nonce = parseInt(await rpc("eth_getTransactionCount", [account.address, "pending"]), 16);
  const gasPrice = tx.gasPrice ? BigInt(tx.gasPrice) : BigInt(await rpc("eth_gasPrice", []));
  const raw = await account.signTransaction({
    type: "legacy",
    chainId: CHAIN_ID,
    nonce,
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gas: BigInt(tx.gas),
    gasPrice
  });
  return rpc("eth_sendRawTransaction", [raw]);
};

let browser;
const consoleLines = [];
const pageErrors = [];
let exitCode = 0;
try {
  console.log(`[E2E] frontend served at ${URL_}; wallet ${account.address}`);

  // Fresh studio-next accounts hold no GEN; fund the mock wallet for escrow + fees.
  await mkdir(SHOTS, { recursive: true });
  await rpc("sim_fundAccount", [account.address, Number(100n * 10n ** 18n)]);

  // Puppeteer's bundled Chromium by default; fall back to a system Chrome if it was not downloaded.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
    (existsSync(puppeteer.executablePath() || "") ? undefined : [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
    ].find(existsSync));
  browser = await puppeteer.launch({
    executablePath,
    headless: !process.env.HEADED,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  page.on("console", (m) => {
    consoleLines.push(m.text());
    if (m.text().startsWith("[handleCreatePool]") || m.type() === "error") {
      console.log(`[browser:${m.type()}] ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => { pageErrors.push(String(e)); console.log(`[browser:pageerror] ${e}`); });

  // Node-side bridges used by the injected wallet.
  await page.exposeFunction("__e2eRpc", (method, params) => rpc(method, params));
  await page.exposeFunction("__e2eSend", (tx) => signAndSend(tx));

  // Mock EIP-1193 wallet, installed before any page script runs.
  await page.evaluateOnNewDocument((address, chainIdHex) => {
    const listeners = {};
    let chainId = chainIdHex;
    const provider = {
      isMetaMask: true,
      isE2EMock: true,
      async request({ method, params = [] }) {
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts": return [address];
          case "eth_chainId": return chainId;
          case "net_version": return String(parseInt(chainId, 16));
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain": return null;
          case "eth_sendTransaction": return window.__e2eSend(params[0]);
          default: return window.__e2eRpc(method, params);
        }
      },
      on(ev, fn) { (listeners[ev] ||= []).push(fn); },
      removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); }
    };
    window.ethereum = provider;
    const info = { uuid: "e2e-mock-wallet", name: "E2E Mock Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, account.address, "0xF22D");

  await page.goto(URL_, { waitUntil: "networkidle2", timeout: 90_000 });
  await page.waitForFunction(() => window.ImmuniChain || document.querySelector("#connectWalletBtn"), { timeout: 60_000 });
  check("frontend loaded", true, await page.title());

  // 1. Connect the (mock) wallet through the real header button.
  await page.waitForFunction(() => typeof window.handleWalletBtnClick === "function");
  await page.click("#connectWalletBtn");
  await page.waitForFunction(
    (addr) => document.body.innerText.toLowerCase().includes(addr.slice(2, 6).toLowerCase()) ||
      (document.getElementById("consensusTerminalLogs")?.innerText || "").includes("[WALLET] Connected"),
    { timeout: 60_000 },
    account.address
  );
  check("wallet connected via UI", true, account.address);

  // 2. Open the Create Pool modal with the real button and fill the DOM form.
  await page.click('.nav-link[data-tab="pools"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button[onclick="openCreatePoolModal()"]')].some((b) => b.offsetParent !== null));
  const openBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button[onclick="openCreatePoolModal()"]')].find((b) => b.offsetParent !== null));
  await openBtn.asElement().click();
  await page.waitForSelector("#createPoolModal:not(.hidden)", { visible: true });
  check("create pool modal open", true);

  const fields = {
    "#newPoolName": POOL.name, "#newPoolRepo": POOL.repo, "#newPoolDesc": POOL.desc,
    "#newPoolDeposit": POOL.deposit, "#newPoolCritical": POOL.critical,
    "#newPoolHigh": POOL.high, "#newPoolMedium": POOL.medium, "#newPoolLow": POOL.low
  };
  for (const [sel, value] of Object.entries(fields)) {
    await page.focus(sel);
    await page.$eval(sel, (el) => { el.value = ""; }); // clear pre-filled defaults
    await page.type(sel, value);
  }
  const filled = await page.evaluate((f) => Object.fromEntries(Object.keys(f).map((s) => [s, document.querySelector(s).value])), fields);
  check("form inputs filled in DOM", JSON.stringify(filled) === JSON.stringify(fields), JSON.stringify(filled));

  // 3. Click the submit button (triggers form 'submit' -> handleCreatePool).
  await page.screenshot({ path: join(SHOTS, "1-form-filled.png") });
  await page.click('#createPoolForm button[type="submit"]');
  const started = Date.now();
  while (!consoleLines.some((l) => l.includes("[handleCreatePool] invoked"))) {
    if (Date.now() - started > 15_000) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("submit click invoked handleCreatePool", consoleLines.some((l) => l.includes("[handleCreatePool] invoked")));

  // 4. Wait for the on-chain flow to finish: success log or failure toast.
  const outcome = await page.waitForFunction(() => {
    const logs = document.getElementById("consensusTerminalLogs")?.innerText || "";
    if (logs.includes("[CHAIN] Pool created and escrow locked on-chain.")) return "success";
    if (logs.includes("[TX_ERROR]")) return "error: " + logs.split("\n").filter((l) => l.includes("[TX_ERROR]")).pop();
    return false;
  }, { timeout: TX_TIMEOUT_MS, polling: 1000 }).then((h) => h.jsonValue());
  await page.screenshot({ path: join(SHOTS, "2-after-submit.png") });
  check("handleCreatePool flow succeeded", outcome === "success", outcome);

  const txLine = consoleLines.find((l) => l.startsWith("[handleCreatePool] success tx="));
  const txHash = txLine?.split("tx=")[1];
  check("tx hash emitted", /^0x[0-9a-fA-F]{64}$/.test(txHash || ""), txHash);
  const toast = await page.evaluate(() => document.getElementById("toastContainer").innerText);
  check("success toast shown", /created/i.test(toast), toast.replace(/\n/g, " | "));

  // 5. No RPC / unhandled errors, and the pool exists on-chain afterwards.
  check("no unhandled page errors", pageErrors.length === 0, pageErrors.join("; "));
  const bad = consoleLines.filter((l) => /Contract not found|\[create_bounty_pool\] failed|Unhandled/i.test(l));
  check("no 'Contract not found' / RPC failures in console", bad.length === 0, bad.join("; "));
  const onChain = await page.evaluate(() => window.ImmuniChain.read("get_all_pools", []));
  check("new pool visible on-chain via the UI's genlayer-js client", String(onChain).includes(POOL.name));

  console.log(`\n[E2E] ALL ${results.length} CHECKS PASSED; screenshots in ${SHOTS}`);
} catch (err) {
  exitCode = 1;
  console.error(`\n[E2E] FAILED: ${err.message}`);
  if (browser) {
    const pages = await browser.pages();
    await pages[pages.length - 1]?.screenshot({ path: join(SHOTS, "failure.png") }).catch(() => {});
  }
} finally {
  await browser?.close();
  server.close();
  process.exit(exitCode);
}
