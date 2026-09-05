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
 */
(function () {
  var storedAddress = null;
  try {
    storedAddress = localStorage.getItem("immunilayer_contract");
  } catch (e) {
    storedAddress = null;
  }

  window.IMMUNI_CONFIG = {
    // Deployed ImmuniLayer contract address on the target GenLayer network.
    contractAddress: storedAddress || "0xD5e2b1AE71cd4a57b7b095d467EcF282030Da42e",
    // Target GenLayer network for both reads and writes.
    chainName: "studionet",
    // Native GEN uses 18 decimals (1 GEN = 10^18 wei).
    genDecimals: 18
  };
})();
