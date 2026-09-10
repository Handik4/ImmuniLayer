/**
 * ImmuniLayer Protocol - Frontend Configuration
 *
 * The frontend talks directly to the deployed ImmuniLayer intelligent contract
 * on GenLayer through genlayer-js. Set the deployed contract address below (or
 * override it at runtime from the browser console with:
 *   localStorage.setItem("immunilayer_contract", "0x...")
 * ).
 *
 * Available chain names: "studionet", "localnet", "testnetAsimov", "testnetBradbury".
 * The "studionet" chain is pinned to the studio-dev endpoints in
 * genlayer-client.js (RPC https://studio-dev.genlayer.com/api, Chain ID 61997).
 */
(function () {
  var storedAddress = null;
  try {
    storedAddress = localStorage.getItem("immunilayer_contract");
  } catch (e) {
    storedAddress = null;
  }

  window.IMMUNI_CONFIG = {
    // Deployed ImmuniLayer contract address on GenLayer Studio Devnet (studio-dev).
    contractAddress: storedAddress || "0x5aDf4EA71be5D047a9e8E73826f7aa1414fC183f",
    // Target GenLayer network for both reads and writes.
    chainName: "studionet",
    // Native GEN uses 18 decimals (1 GEN = 10^18 wei).
    genDecimals: 18
  };
})();
