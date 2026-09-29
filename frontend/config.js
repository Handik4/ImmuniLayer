/**
 * ImmuniLayer Protocol - Frontend Configuration
 *
 * The frontend talks directly to the deployed ImmuniLayer intelligent contract
 * on GenLayer through genlayer-js. The contract address is hardcoded (no
 * environment variable or browser storage can override it), so a missing
 * Vercel env var or a stale browser value can never point the app at a
 * contract that does not exist ("Contract not found").
 *
 * Network: GenLayer Studio Next (studio-next), RPC https://studio-next.genlayer.com/api,
 * Chain ID 61997. "studionet" below resolves to genlayer-js's studioDevnet
 * chain in genlayer-client.js.
 *
 * When redeploying, update this address and run `cd scripts && npm run e2e`.
 */
(function () {
  // Older builds let localStorage override the address; a stale value there
  // pointed some browsers at a dead contract. Drop it.
  try {
    localStorage.removeItem("immunilayer_contract");
  } catch (e) {
    /* storage unavailable - nothing to clear */
  }

  window.IMMUNI_CONFIG = {
    // Live ImmuniLayer contract on GenLayer Studio Next (studio-next).
    contractAddress: "0x1119f5Dca02E9C2C87E41576AF4D1a47aA526623",
    // Target GenLayer network for both reads and writes.
    chainName: "studionet",
    // Native GEN uses 18 decimals (1 GEN = 10^18 wei).
    genDecimals: 18
  };
})();
