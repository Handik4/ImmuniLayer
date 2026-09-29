/**
 * ImmuniLayer Protocol - genlayer-js Client Layer
 *
 * ES module that wraps genlayer-js and exposes a promise-based API on
 * window.ImmuniChain. Every pool, disclosure, verdict, and payout shown in the
 * dashboard comes from REAL reads and writes against the deployed intelligent
 * contract. No mock data is produced here.
 *
 * Network: GenLayer Studio Devnet (studio-dev), Chain ID 61997 (0xF22D).
 * Read client: public RPC, no wallet needed.
 * Write client: created on wallet connect; signs every transaction through the
 *   selected EIP-1193 provider (strict EIP-6963 MetaMask selection) OR through
 *   an ephemeral genlayer-js reviewer account for friction-free testing.
 */

// Pinned to 2.0.0-rc.1: it ships the native studio-dev chain (id 61997) and the
// fees-distribution transaction format studio-dev consensus requires. Unpinned
// esm.sh resolves to 1.x, whose transactions revert on studio-dev
// (FeesDistributionMissing) and whose bundled studionet points at 61999.
import { createClient, createAccount } from "https://esm.sh/genlayer-js@2.0.0-rc.1";
import { studioDevnet, studionet, localnet, testnetAsimov, testnetBradbury } from "https://esm.sh/genlayer-js@2.0.0-rc.1/chains";
import { TransactionStatus } from "https://esm.sh/genlayer-js@2.0.0-rc.1/types";

// ---------------------------------------------------------------------------
// Studio Devnet network parameters (Chain ID 61997)
// ---------------------------------------------------------------------------
const STUDIONET_CHAIN_ID_HEX = "0xF22D"; // 61997 decimal
const STUDIONET_CHAIN_ID_DEC = 61997;

// Official studio-dev endpoints (Chain ID 61997).
const STUDIO_BASE = "https://studio-dev.genlayer.com";
const STUDIO_RPC_URL = STUDIO_BASE + "/api";
// Block explorer is served from a distinct host.
const EXPLORER_BASE = "https://explorer-studio-dev.genlayer.com";

const STUDIONET_PARAMS = {
  chainId: STUDIONET_CHAIN_ID_HEX,
  chainName: "GenLayer Studio Devnet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: [STUDIO_RPC_URL],
  blockExplorerUrls: [EXPLORER_BASE]
};

// StudioNet transaction explorer base URL (append tx hash to open detail page).
const EXPLORER_TX_BASE = EXPLORER_BASE + "/tx/";

// ---------------------------------------------------------------------------
// EIP-6963 provider discovery
// ---------------------------------------------------------------------------
// Phantom (and other wallets) aggressively override window.ethereum and can
// inject MetaMask Snap methods that throw RPC -32601 ("method not found").
// We discover providers via EIP-6963 and prefer the genuine MetaMask provider
// (rdns === "io.metamask") so we sign against the wallet the reviewer expects.
const discoveredProviders = [];

function registerProvider(detail) {
  if (!detail || !detail.info || !detail.provider) return;
  const rdns = detail.info.rdns;
  const existing = discoveredProviders.find((p) => p.info.rdns === rdns);
  if (existing) {
    existing.provider = detail.provider;
  } else {
    discoveredProviders.push({ info: detail.info, provider: detail.provider });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    registerProvider(event.detail);
  });
  // Ask any already-loaded wallets to announce themselves.
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch (e) {
    /* non-fatal */
  }
}

/**
 * Select the EIP-1193 provider to sign with.
 * Priority: EIP-6963 MetaMask (io.metamask) > any EIP-6963 provider >
 * window.ethereum (with providers[] scan for a non-Phantom MetaMask).
 */
function selectInjectedProvider() {
  const mm = discoveredProviders.find((p) => p.info.rdns === "io.metamask");
  if (mm) return mm.provider;

  if (discoveredProviders.length > 0) return discoveredProviders[0].provider;

  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!eth) return undefined;

  // Legacy multi-provider array: prefer a MetaMask that is not Phantom's shim.
  if (Array.isArray(eth.providers) && eth.providers.length > 0) {
    const realMM = eth.providers.find((p) => p.isMetaMask && !p.isPhantom);
    if (realMM) return realMM;
    const anyMM = eth.providers.find((p) => p.isMetaMask);
    if (anyMM) return anyMM;
    return eth.providers[0];
  }
  return eth;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
const CHAINS = {
  // "studionet" in IMMUNI_CONFIG means the live studio-dev network (61997).
  studionet: studioDevnet,
  studioDevnet: studioDevnet,
  legacyStudionet: studionet,
  localnet: localnet,
  testnetAsimov: testnetAsimov,
  testnetBradbury: testnetBradbury
};

// genlayer-js network name understood by client.connect().
function connectNetworkName() {
  const name = (window.IMMUNI_CONFIG && window.IMMUNI_CONFIG.chainName) || "studionet";
  return name === "studionet" ? "studioDevnet" : name;
}

function activeChain() {
  const name = (window.IMMUNI_CONFIG && window.IMMUNI_CONFIG.chainName) || "studionet";
  const chain = CHAINS[name] || studioDevnet;
  if (chain === studioDevnet && (chain.id !== STUDIONET_CHAIN_ID_DEC ||
      chain.rpcUrls.default.http[0] !== STUDIO_RPC_URL)) {
    // Guard against a genlayer-js upgrade silently retargeting studio-dev.
    throw new Error("genlayer-js studioDevnet does not match " + STUDIO_RPC_URL + " / " + STUDIONET_CHAIN_ID_DEC);
  }
  return chain;
}

function contractAddress() {
  return window.IMMUNI_CONFIG.contractAddress;
}

/**
 * Ensure the selected provider is on GenLayer Studio Devnet (Chain ID 61997).
 * Every wallet RPC call is wrapped so a Snap-related -32601 (or a user
 * rejection) never aborts the connect flow.
 */
async function ensureCorrectNetwork(provider) {
  if (!provider || typeof provider.request !== "function") return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIONET_CHAIN_ID_HEX }]
    });
  } catch (switchErr) {
    // 4902 = chain not added yet; -32603 = same on some wallets.
    if (switchErr && (switchErr.code === 4902 || switchErr.code === -32603)) {
      try {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [STUDIONET_PARAMS]
        });
      } catch (addErr) {
        // -32601 (method not found, e.g. Phantom Snap shim) is non-fatal here.
        if (!addErr || addErr.code !== -32601) {
          console.warn("[ImmuniChain] add network warning:", addErr);
        }
      }
    } else if (switchErr && switchErr.code === -32601) {
      // Snap override intercepted the call; ignore and continue.
      console.warn("[ImmuniChain] switch network intercepted (-32601), continuing.");
    }
    // Any other error (user rejected, etc.) is surfaced by the caller.
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let readClient = null;
let writeClient = null;
let connectedAccount = null;
let connectionMode = null; // "wallet" | "reviewer"

// ---------------------------------------------------------------------------
// Consensus v0.6 receipt evaluation
// ---------------------------------------------------------------------------
// Under GenLayer Consensus v0.6 a transaction reaching ACCEPTED or FINALIZED
// status only means the validator quorum agreed on an OUTCOME - and that
// outcome can be a revert. A call is only truly successful when the leader
// receipt's execution_result is SUCCESS / FINISHED_WITH_RETURN. We therefore gate success
// on BOTH the transaction status AND the execution result, and surface the
// underlying revert reason otherwise (never a false "success").
const SUCCESS_STATUSES = ["ACCEPTED", "FINALIZED"];
// genlayer-js 2.x reports the leader receipt as SUCCESS; 1.x as FINISHED_WITH_RETURN.
const SUCCESS_EXECUTIONS = ["SUCCESS", "FINISHED_WITH_RETURN"];

function _upper(v) {
  return typeof v === "string" ? v.toUpperCase() : v;
}

function receiptStatusName(receipt) {
  if (!receipt) return undefined;
  return _upper(receipt.statusName || receipt.status_name || receipt.status);
}

function leaderReceipt(receipt) {
  const cd = receipt && (receipt.consensusData || receipt.consensus_data);
  let lr = cd && (cd.leaderReceipt || cd.leader_receipt);
  if (Array.isArray(lr)) lr = lr[0];
  return lr || undefined;
}

function receiptExecutionResult(receipt) {
  if (!receipt) return undefined;
  const lr = leaderReceipt(receipt);
  return _upper(
    (lr && (lr.executionResult || lr.execution_result)) ||
    receipt.txExecutionResultName ||
    receipt.executionResult ||
    receipt.execution_result
  );
}

/** Extract a human-readable revert reason from a reverted GenVM receipt. */
function extractRevertReason(receipt) {
  const lr = leaderReceipt(receipt);
  const gv = lr && (lr.genvmResult || lr.genvm_result);
  const candidates = [
    lr && lr.result && lr.result.payload,
    lr && lr.result && lr.result.status,
    gv && gv.stderr,
    receipt && receipt.result && receipt.result.payload,
    receiptExecutionResult(receipt) &&
      ("execution_result=" + receiptExecutionResult(receipt))
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "the quorum agreed on a non-successful outcome (no return value)";
}

// ---------------------------------------------------------------------------
// Public API exposed on window.ImmuniChain
// ---------------------------------------------------------------------------
const ImmuniChain = {
  TransactionStatus,

  /** Return a StudioNet explorer URL for a given transaction hash. */
  explorerTxUrl(hash) {
    return EXPLORER_TX_BASE + (hash || "");
  },

  address() {
    return connectedAccount;
  },

  mode() {
    return connectionMode;
  },

  isConnected() {
    return !!writeClient && !!connectedAccount;
  },

  getReadClient() {
    if (!readClient) {
      readClient = createClient({ chain: activeChain() });
    }
    return readClient;
  },

  /**
   * Read a view method. Contract view methods return JSON strings; callers
   * typically JSON.parse the result.
   */
  async read(functionName, args = []) {
    const client = this.getReadClient();
    return await client.readContract({
      address: contractAddress(),
      functionName: functionName,
      args: args,
      stateStatus: "accepted"
    });
  },

  /**
   * Connect a browser wallet via strict EIP-6963 MetaMask selection and switch
   * it to GenLayer Studio Devnet (Chain ID 61997). Returns the connected account.
   */
  async connect() {
    const provider = selectInjectedProvider();
    if (!provider) {
      throw new Error(
        "No browser wallet detected. Install MetaMask, or use the one-click Reviewer Account for testing."
      );
    }

    // Switch to / add GenLayer StudioNet before requesting accounts so the
    // wallet presents the correct network during approval.
    await ensureCorrectNetwork(provider);

    let accounts;
    try {
      accounts = await provider.request({ method: "eth_requestAccounts" });
    } catch (reqErr) {
      if (reqErr && reqErr.code === -32601) {
        throw new Error(
          "Wallet intercepted the account request (RPC -32601). Disable conflicting wallet extensions (e.g. Phantom) or use the Reviewer Account."
        );
      }
      throw reqErr;
    }
    if (!accounts || accounts.length === 0) {
      throw new Error("No account was authorized by the wallet.");
    }
    connectedAccount = accounts[0];
    connectionMode = "wallet";

    writeClient = createClient({
      chain: activeChain(),
      account: connectedAccount,
      provider: provider
    });

    try {
      await writeClient.connect(connectNetworkName());
    } catch (e) {
      console.warn("[ImmuniChain] genlayer-js chain connect warning:", e);
    }
    // connect() swaps client.chain for its bundled network object; re-pin the
    // studio-dev chain so writes always target the right RPC and consensus.
    writeClient.chain = activeChain();

    return connectedAccount;
  },

  /**
   * One-click ephemeral "Reviewer / Ephemeral" account. Generates a fresh
   * genlayer-js account (local key) so a reviewer can exercise the full flow
   * without installing a wallet. Returns the account address.
   */
  async connectReviewer() {
    const account = createAccount();
    connectedAccount = account.address;
    connectionMode = "reviewer";

    // Local-key account: no wallet/snap needed, so client.connect() is skipped
    // (it would prompt an installed MetaMask and replace the pinned chain).
    writeClient = createClient({
      chain: activeChain(),
      account: account
    });

    // Fresh studio-dev accounts hold no GEN; fund the ephemeral key so it can
    // pay the escrow deposit and consensus fees.
    try {
      await writeClient.request({
        method: "sim_fundAccount",
        params: [account.address, Number(100n * 10n ** 18n)]
      });
    } catch (e) {
      console.warn("[ImmuniChain] reviewer funding warning:", e);
    }

    return connectedAccount;
  },

  disconnect() {
    writeClient = null;
    connectedAccount = null;
    connectionMode = null;
  },

  /**
   * Send a write transaction. value is a BigInt amount of wei to forward to a
   * payable method (0n for non-payable calls). Returns the transaction hash.
   */
  async write(functionName, args = [], value = 0n) {
    if (!writeClient) {
      throw new Error("Wallet not connected. Connect a wallet or use the Reviewer Account first.");
    }
    const call = {
      address: contractAddress(),
      functionName: functionName,
      args: args,
      value: value
    };
    // studio-dev consensus rejects transactions without a fees distribution
    // and a non-zero fee value, so estimate them per call.
    const est = await writeClient.estimateTransactionFeesForWrite(call);
    return await writeClient.writeContract({
      ...call,
      fees: {
        distribution: est.distribution,
        messageAllocations: est.messageAllocations,
        feeValue: est.feeValue
      }
    });
  },

  /**
   * Consensus v0.6 success predicate. Returns true only when the transaction
   * reached ACCEPTED/FINALIZED AND the leader execution finished with a return
   * value. Prefers the SDK's own client.isSuccessful() when available.
   */
  isSuccessful(receipt) {
    const statusOk = SUCCESS_STATUSES.includes(receiptStatusName(receipt));
    const execOk = SUCCESS_EXECUTIONS.includes(receiptExecutionResult(receipt));
    return statusOk && execOk;
  },

  /** Expose the revert reason extractor for callers that catch a failure. */
  revertReason(receipt) {
    return extractRevertReason(receipt);
  },

  /**
   * Wait for a transaction receipt and assert real success under Consensus
   * v0.6. Reaching ACCEPTED/FINALIZED status is NOT sufficient - the quorum may
   * have agreed on a revert. We therefore require execution_result to be
   * FINISHED_WITH_RETURN (or the SDK's isSuccessful) and otherwise throw a
   * descriptive revert error so callers surface the real reason instead of a
   * false success. Requests the full transaction so callers can read the
   * decoded return value directly from the receipt (race-free readback).
   */
  async waitReceipt(hash, status) {
    const client = writeClient || this.getReadClient();
    const receipt = await client.waitForTransactionReceipt({
      hash: hash,
      status: status || TransactionStatus.ACCEPTED,
      fullTransaction: true
    });
    if (!this.isSuccessful(receipt)) {
      const err = new Error(
        "Transaction reverted on-chain: " + extractRevertReason(receipt)
      );
      err.reverted = true;
      err.receipt = receipt;
      throw err;
    }
    return receipt;
  },

  /**
   * Best-effort extraction of a contract method's return value from a receipt.
   * GenLayer receipt shapes vary across SDK versions, so we probe the common
   * locations. Returns undefined if not present (caller should fall back).
   */
  decodeReturn(receipt) {
    if (!receipt) return undefined;
    const candidates = [
      receipt.result,
      receipt.returnValue,
      receipt.data && receipt.data.result,
      receipt.consensus_data && receipt.consensus_data.leader_receipt &&
        receipt.consensus_data.leader_receipt.result,
      receipt.tx_data_decoded && receipt.tx_data_decoded.result
    ];
    for (const c of candidates) {
      if (c !== undefined && c !== null) return c;
    }
    return undefined;
  }
};

window.ImmuniChain = ImmuniChain;
window.dispatchEvent(new Event("immunichain:ready"));
