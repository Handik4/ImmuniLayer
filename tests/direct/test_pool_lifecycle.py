"""
Direct-Mode Tests: Bounty Pool Lifecycle

Tests create_bounty_pool, deposit_bounty_funds, withdraw_pool_funds, and all
associated validation gates using the real ImmuniLayer contract loaded via
gltest.direct.deploy_contract. No mock simulation classes.
"""

import json
import pytest
from conftest import CONTRACT_PATH, ONE_GEN


# ---------------------------------------------------------------------------
# Pool creation
# ---------------------------------------------------------------------------

def test_create_pool_success(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))

    direct_vm.sender = direct_bob
    direct_vm.value = 100 * ONE_GEN

    pool_id = contract.create_bounty_pool(
        "Nexus Cross-Chain Bridge",
        "https://github.com/nexus-core/bridge-router",
        "Omni-chain message passing contracts",
        50 * ONE_GEN,   # max_critical
        20 * ONE_GEN,   # max_high
        5 * ONE_GEN,    # max_medium
        ONE_GEN,        # max_low
    )

    assert pool_id == 1

    pool = json.loads(contract.get_pool(1))
    assert pool["id"] == 1
    assert pool["name"] == "Nexus Cross-Chain Bridge"
    assert pool["balance"] == str(100 * ONE_GEN)
    assert pool["max_critical"] == str(50 * ONE_GEN)
    assert pool["max_high"] == str(20 * ONE_GEN)
    assert pool["is_active"] is True
    # owner is stored as checksum hex; bytes direct_bob matches via 0x + hex()
    assert pool["owner"].lower() == ("0x" + direct_bob.hex()).lower()

    stats = json.loads(contract.get_protocol_stats())
    assert stats["total_pools"] == 1
    assert stats["total_reports"] == 0


def test_create_pool_empty_name_reverts(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 10 * ONE_GEN

    with direct_vm.expect_revert("[EXPECTED] Pool name cannot be empty"):
        contract.create_bounty_pool(
            "   ",
            "https://github.com/test",
            "desc",
            5 * ONE_GEN, 2 * ONE_GEN, ONE_GEN, ONE_GEN // 5,
        )


def test_create_pool_invalid_url_reverts(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 10 * ONE_GEN

    with direct_vm.expect_revert("[EXPECTED] Valid repository URL is required"):
        contract.create_bounty_pool(
            "Test Protocol",
            "not-a-url",
            "desc",
            5 * ONE_GEN, 2 * ONE_GEN, ONE_GEN, ONE_GEN // 5,
        )


def test_create_pool_inverted_hierarchy_reverts(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 50 * ONE_GEN

    # max_high (10 GEN) > max_critical (5 GEN) violates hierarchy
    with direct_vm.expect_revert(
        "[EXPECTED] Severity caps must follow CRITICAL >= HIGH >= MEDIUM >= LOW hierarchy"
    ):
        contract.create_bounty_pool(
            "Protocol",
            "https://github.com/test",
            "desc",
            5 * ONE_GEN,    # critical
            10 * ONE_GEN,   # high > critical - INVALID
            2 * ONE_GEN,
            ONE_GEN // 5,
        )


def test_create_pool_zero_deposit_reverts(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 0  # No deposit

    with direct_vm.expect_revert(
        "[EXPECTED] A non-zero GEN escrow deposit is required to open a pool"
    ):
        contract.create_bounty_pool(
            "Protocol",
            "https://github.com/test",
            "desc",
            5 * ONE_GEN, 2 * ONE_GEN, ONE_GEN, ONE_GEN // 5,
        )


# ---------------------------------------------------------------------------
# Deposit top-up
# ---------------------------------------------------------------------------

def test_deposit_bounty_funds(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 100 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Solace Yield",
        "https://github.com/solace/yield",
        "Yield vaults",
        40 * ONE_GEN, 15 * ONE_GEN, 5 * ONE_GEN, ONE_GEN,
    )

    direct_vm.value = 50 * ONE_GEN
    new_bal = contract.deposit_bounty_funds(pool_id)

    assert new_bal == str(150 * ONE_GEN)
    pool = json.loads(contract.get_pool(pool_id))
    assert pool["balance"] == str(150 * ONE_GEN)


def test_deposit_zero_reverts(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 10 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Test",
        "https://github.com/test",
        "desc",
        5 * ONE_GEN, 2 * ONE_GEN, ONE_GEN, ONE_GEN // 5,
    )

    direct_vm.value = 0
    with direct_vm.expect_revert("[EXPECTED] Deposit amount must be positive"):
        contract.deposit_bounty_funds(pool_id)


def test_deposit_nonexistent_pool_reverts(direct_vm, direct_deploy):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.value = 10 * ONE_GEN

    with direct_vm.expect_revert("[EXPECTED] Pool ID 99 does not exist"):
        contract.deposit_bounty_funds(99)


# ---------------------------------------------------------------------------
# Withdraw (escrow refund to owner)
# ---------------------------------------------------------------------------

def test_withdraw_pool_funds_by_owner(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 100 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Test Pool",
        "https://github.com/test",
        "Desc",
        50 * ONE_GEN, 20 * ONE_GEN, 5 * ONE_GEN, ONE_GEN,
    )

    # Owner withdraws remaining escrow
    direct_vm.sender = direct_bob
    direct_vm.value = 0
    withdrawn = contract.withdraw_pool_funds(pool_id)
    assert withdrawn == str(100 * ONE_GEN)

    pool = json.loads(contract.get_pool(pool_id))
    assert pool["balance"] == "0"
    assert pool["is_active"] is False


def test_withdraw_by_non_owner_reverts(direct_vm, direct_deploy, direct_bob, direct_alice):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 100 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Test Pool",
        "https://github.com/test",
        "Desc",
        50 * ONE_GEN, 20 * ONE_GEN, 5 * ONE_GEN, ONE_GEN,
    )

    direct_vm.sender = direct_alice  # Not the owner
    direct_vm.value = 0
    with direct_vm.expect_revert("[EXPECTED] Only the pool owner can withdraw escrow"):
        contract.withdraw_pool_funds(pool_id)


# ---------------------------------------------------------------------------
# Multi-pool indexing
# ---------------------------------------------------------------------------

def test_get_all_pools_returns_ordered_list(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob

    direct_vm.value = 10 * ONE_GEN
    contract.create_bounty_pool(
        "P1", "https://github.com/p1", "D1",
        5 * ONE_GEN, 2 * ONE_GEN, ONE_GEN, ONE_GEN // 5,
    )

    direct_vm.value = 20 * ONE_GEN
    contract.create_bounty_pool(
        "P2", "https://github.com/p2", "D2",
        8 * ONE_GEN, 3 * ONE_GEN, 2 * ONE_GEN, ONE_GEN // 2,
    )

    pools = json.loads(contract.get_all_pools())
    assert len(pools) == 2
    assert pools[0]["name"] == "P1"
    assert pools[1]["name"] == "P2"

    stats = json.loads(contract.get_protocol_stats())
    assert stats["total_pools"] == 2
