#!/usr/bin/env python3
"""
ImmuniLayer live on-chain interaction (GenLayer Studio Next, chain 61997).

1. loads the dedicated local key from ../.env (created on first run, git-ignored)
2. funds it through Studio Next's sim_fundAccount
3. calls create_bounty_pool with a real escrow deposit AND an explicit fees
   distribution + fee value (avoids FeesDistributionMissing)
4. waits for ACCEPTED, checks the leader execution result, reads the pool back

Usage: python3 scripts/interact_live.py   (needs genlayer-py >= 0.19.0rc2)
"""
import json
import os
import sys
import time
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from eth_account import Account
from genlayer_py import create_client, create_account
from genlayer_py.chains import studio_devnet

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"
RPC = "https://studio-next.genlayer.com/api"
EXPLORER = "https://explorer-studio-next.genlayer.com"
CHAIN_ID = 61997
GEN = 10**18


def contract_address() -> str:
    import re
    cfg = (ROOT / "frontend" / "config.js").read_text()
    m = re.search(r'contractAddress:\s*"(0x[0-9a-fA-F]{40})"', cfg)
    if not m:
        sys.exit("contract address not found in frontend/config.js")
    return os.environ.get("CONTRACT_ADDRESS", m.group(1))


def load_or_create_key() -> str:
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    if "IMMUNI_PRIVATE_KEY" not in env:
        acct = Account.create()
        key = "0x" + acct.key.hex().removeprefix("0x")
        with ENV_FILE.open("a") as f:
            f.write(f"IMMUNI_PRIVATE_KEY={key}\nIMMUNI_ADDRESS={acct.address}\n")
        ENV_FILE.chmod(0o600)
        print(f"created dedicated key in .env -> {acct.address}")
        return key
    return env["IMMUNI_PRIVATE_KEY"]


def main() -> None:
    address = contract_address()
    account = create_account(load_or_create_key())

    chain = deepcopy(studio_devnet)  # id 61997, consensus contracts; retarget RPC
    chain.name = "GenLayer Studio Next"
    chain.rpc_urls = {"default": {"http": [RPC]}}
    chain.block_explorers = {"default": {"name": "GenLayer Studio Next Explorer", "url": EXPLORER}}
    client = create_client(chain=chain, endpoint=RPC, account=account)

    chain_id = int(client.provider.make_request("eth_chainId", [])["result"], 16)
    print(f"network: {RPC} chainId={chain_id}")
    if chain_id != CHAIN_ID:
        sys.exit(f"expected chain {CHAIN_ID}, got {chain_id}")

    schema = client.get_contract_schema(address)
    print("contract:", address, "| methods:", ", ".join(schema["methods"]))

    print("funding", account.address)
    client.provider.make_request("sim_fundAccount", [account.address, 10 * GEN])

    stats_before = json.loads(client.read_contract(address=address, function_name="get_protocol_stats"))
    name = f"Live Pool {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
    call = dict(
        address=address,
        function_name="create_bounty_pool",
        args=[name, "https://github.com/genlayerlabs/genlayer-js", "Live on-chain pool",
              5 * GEN, 3 * GEN, 2 * GEN, 1 * GEN],
        value=1 * GEN,  # escrow deposit forwarded to the payable method
    )
    est = client.estimate_transaction_fees_for_write(**call)
    print("estimated fee value (wei):", est["feeValue"])
    fees = {"distribution": est["distribution"], "feeValue": est["feeValue"]}
    if est.get("messageAllocations") is not None:
        fees["messageAllocations"] = est["messageAllocations"]
    tx_hash = client.write_contract(**call, fees=fees)
    print("tx hash:", tx_hash)
    print("explorer:", f"{EXPLORER}/tx/{tx_hash}")

    receipt = client.wait_for_transaction_receipt(
        transaction_hash=tx_hash, wait_until="decided", retries=100, interval=3000, full_transaction=True
    )
    # wait_until="decided" returns once the validator quorum has ruled (ACCEPTED).
    # The ruling can still be a revert, so check the execution result as well.
    execution = receipt.get("txExecutionResultName")
    decision = receipt.get("result_name")
    print(f"decision={decision} execution_result={execution}")
    if execution != "FINISHED_WITH_RETURN" or decision not in ("MAJORITY_AGREE", "AGREE"):
        sys.exit("transaction did not succeed")

    pools = json.loads(client.read_contract(address=address, function_name="get_all_pools"))
    pools = pools if isinstance(pools, list) else pools.get("pools", list(pools.values()))
    found = next((p for p in pools if p.get("name") == name), None)
    print(f"pools before={stats_before.get('total_pools')} after={len(pools)} created pool found={bool(found)}")
    if not found:
        sys.exit("created pool not found in get_all_pools")
    print(json.dumps(found))
    print("\n[PASS] tx", tx_hash)
    print("       ", f"{EXPLORER}/tx/{tx_hash}")


if __name__ == "__main__":
    main()
