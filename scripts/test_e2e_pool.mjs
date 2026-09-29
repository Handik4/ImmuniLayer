#!/usr/bin/env node
/**
 * ImmuniLayer E2E: create_bounty_pool against the live studio-dev contract.
 *
 * Uses the same address (frontend/config.js), chain (genlayer-js studioDevnet, studio-dev
 * RPC, Chain ID 61997) and call shape (frontend/app.js handleCreatePool) as the
 * browser app, so a pass here proves the app's pool-creation path works.
 *
 * Usage: cd scripts && npm install && npm run e2e
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient, createAccount } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const RPC = "https://studio-dev.genlayer.com/api";
const CHAIN_ID = 61997;
const GEN = 10n ** 18n;

const here = dirname(fileURLToPath(import.meta.url));
const cfg = readFileSync(join(here, "..", "frontend", "config.js"), "utf8");
const m = cfg.match(/contractAddress:\s*storedAddress\s*\|\|\s*"(0x[0-9a-fA-F]{40})"/) ||
  cfg.match(/contractAddress:\s*"(0x[0-9a-fA-F]{40})"/);
if (!m) throw new Error("could not find contract address in frontend/config.js");
const ADDRESS = process.env.CONTRACT_ADDRESS || m[1];

const rpc = async (method, params) => {
  const r = await (await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const step = (s) => console.log(`\n[STEP] ${s}`);

// Native studio-dev chain (id 61997, RPC studio-dev.genlayer.com/api, with the
// fee-manager contracts studio-dev consensus requires). The frontend uses this too.
const chain = studioDevnet;

step(`network check (${RPC})`);
const chainId = parseInt(await rpc("eth_chainId", []), 16);
console.log("chainId:", chainId);
if (chainId !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID}, got ${chainId}`);

step(`contract lookup ${ADDRESS}`);
const schema = await rpc("gen_getContractSchema", [ADDRESS]); // throws "not found" if undeployed
console.log("methods:", Object.keys(schema.methods).join(", "));
if (!schema.methods.create_bounty_pool) throw new Error("create_bounty_pool missing from schema");

const account = createAccount();
console.log("ephemeral account:", account.address);
const client = createClient({ chain, account });
try { await client.connect("studioDevnet"); } catch (e) { console.warn("connect warning:", e.message); }

step("fund account (sim_fundAccount)");
try {
  await rpc("sim_fundAccount", [account.address, Number(50n * GEN)]);
} catch (e) {
  console.warn("fund warning:", e.message);
}

const before = Number(await client.readContract({ address: ADDRESS, functionName: "get_protocol_stats", args: [] }).then((s) => JSON.parse(s).total_pools ?? -1).catch(() => -1));

step("create_bounty_pool (1 GEN escrow)");
const name = `E2E Pool ${new Date().toISOString()}`;
const write = {
  address: ADDRESS,
  functionName: "create_bounty_pool",
  args: [name, "https://github.com/genlayerlabs/genlayer-js", "E2E test pool", 5n * GEN, 3n * GEN, 2n * GEN, 1n * GEN],
  value: 1n * GEN
};
// studio-dev consensus requires a non-zero fee value + fees distribution.
const est = await client.estimateTransactionFeesForWrite(write);
console.log("fee estimate (wei):", est.feeValue.toString());
const hash = await client.writeContract({
  ...write,
  fees: { distribution: est.distribution, messageAllocations: est.messageAllocations, feeValue: est.feeValue }
});
console.log("tx hash:", hash);
console.log("explorer:", `https://explorer-studio-dev.genlayer.com/tx/${hash}`);

step("wait for receipt");
const receipt = await client.waitForTransactionReceipt({
  hash, status: TransactionStatus.ACCEPTED, fullTransaction: true, retries: 100, interval: 3000
});
const status = receipt.statusName || receipt.status_name || receipt.status;
const lr = receipt.consensusData?.leaderReceipt ?? receipt.consensus_data?.leader_receipt;
const exec = (Array.isArray(lr) ? lr[0] : lr)?.executionResult ?? (Array.isArray(lr) ? lr[0] : lr)?.execution_result;
console.log("status:", status, "| execution_result:", exec);
const ok = ["ACCEPTED", "FINALIZED"].includes(String(status).toUpperCase()) &&
  ["SUCCESS", "FINISHED_WITH_RETURN"].includes(String(exec).toUpperCase());
if (!ok) throw new Error(`tx not successful (status=${status}, exec=${exec})`);

step("read back pool");
const pools = JSON.parse(await client.readContract({ address: ADDRESS, functionName: "get_all_pools", args: [], stateStatus: "accepted" }));
const list = Array.isArray(pools) ? pools : pools.pools ?? Object.values(pools);
const found = list.find((p) => p.name === name);
console.log("total pools:", list.length, "| created pool found:", !!found);
if (found) console.log(JSON.stringify(found));
if (!found) throw new Error("created pool not found in get_all_pools");

console.log("\n[PASS] create_bounty_pool executed on", ADDRESS, "without 'Contract not found'");
