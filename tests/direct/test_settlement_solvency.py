"""
Direct-Mode Tests: Pull-Over-Push Settlement, Withdrawal, and Solvency

Covers the hardened economic core:
  - Full lifecycle: deposit -> submit -> evaluate -> withdraw.
  - Consensus credits claimable_balances only; no value is pushed.
  - Independent withdraw() drains the claimable balance (CEI) and reduces
    locked_escrow.
  - Solvency invariant: locked_escrow == sum(claimable) and never exceeds
    total_deposited.
  - Transient fault tolerance: a 429 rate limit reverts with [TRANSIENT].
  - Malformed LLM output reverts with [LLM_ERROR] (never crashes the node).
"""

import json
import pytest
from conftest import (
    CONTRACT_PATH, ONE_GEN,
    critical_ai_verdict, high_ai_verdict,
    mock_source, VULNERABLE_TARGET_SOURCE,
)

AI_PROMPT_PATTERN = r"Principal Security Auditor"
REPO = "https://github.com/aegis/perps"
COMMIT_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
COMMIT_B = "ffeeddccbbaa99887766554433221100ffeeddcc"
FILE_PATH = "contracts/MarginEngine.sol"

POC = """
def test_exploit_flashloan_skew():
    loan = FlashloanProvider.borrow(15_000_000 * 10**18)
    UniswapV3Pool.swap(loan, to_token="COLLATERAL")
    stolen = MarginEngine.get_instance().borrow_max_stablecoins()
    assert stolen >= 3_500_000 * 10**18, "Failed to extract capital"
"""


def _deploy_pool(direct_vm, direct_deploy, direct_bob, deposit=200, crit=80):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = deposit * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Aegis Perpetual DEX", REPO, "Perp engine",
        crit * ONE_GEN, 30 * ONE_GEN, 10 * ONE_GEN, 2 * ONE_GEN,
    )
    return contract, pool_id


def _submit(contract, pool_id, *, title, verdict_mock, direct_vm, sender,
            commit=COMMIT_A):
    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, verdict_mock)
    direct_vm.sender = sender
    direct_vm.value = 0
    return contract.submit_vulnerability(
        pool_id, title, "Oracle Manipulation",
        "MarginEngine.sol #computeCollateralRatio()",
        REPO, commit, FILE_PATH, POC, "Attacker drains escrow.",
    )


# ---------------------------------------------------------------------------
# Full lifecycle: deposit -> submit -> evaluate -> withdraw
# ---------------------------------------------------------------------------

def test_full_lifecycle_deposit_submit_evaluate_withdraw(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob, deposit=200, crit=80)

    # Sponsor tops up via the canonical deposit() entrypoint.
    direct_vm.sender = direct_bob
    direct_vm.value = 50 * ONE_GEN
    contract.deposit(pool_id)

    stats = json.loads(contract.get_protocol_stats())
    assert stats["total_deposited"] == str(250 * ONE_GEN)
    assert stats["locked_escrow"] == "0"

    # Researcher submits; consensus credits (but does NOT push) a CRITICAL bounty.
    _submit(contract, pool_id, title="Critical Oracle Skew Drains Vault",
            verdict_mock=critical_ai_verdict(), direct_vm=direct_vm, sender=direct_alice)

    # 100% of 80 GEN cap credited to the researcher's claimable balance.
    assert contract.get_claimable(direct_alice) == str(80 * ONE_GEN)
    stats = json.loads(contract.get_protocol_stats())
    assert stats["locked_escrow"] == str(80 * ONE_GEN)
    # Pool free balance dropped by the credited payout.
    assert json.loads(contract.get_pool(pool_id))["balance"] == str((250 - 80) * ONE_GEN)

    # Beneficiary pulls their funds.
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    withdrawn = contract.withdraw()
    assert withdrawn == str(80 * ONE_GEN)

    # Claimable drained; locked_escrow released.
    assert contract.get_claimable(direct_alice) == "0"
    stats = json.loads(contract.get_protocol_stats())
    assert stats["locked_escrow"] == "0"
    assert stats["total_deposited"] == str(250 * ONE_GEN)  # deposits are cumulative


# ---------------------------------------------------------------------------
# Withdraw with no balance reverts
# ---------------------------------------------------------------------------

def test_withdraw_without_balance_reverts(
    direct_vm, direct_deploy, direct_bob, direct_charlie
):
    contract, _ = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    direct_vm.sender = direct_charlie
    direct_vm.value = 0
    with direct_vm.expect_revert("[EXPECTED] No claimable bounty balance to withdraw"):
        contract.withdraw()


def test_double_withdraw_reverts(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    _submit(contract, pool_id, title="Critical Oracle Skew Drains Vault",
            verdict_mock=critical_ai_verdict(), direct_vm=direct_vm, sender=direct_alice)

    direct_vm.sender = direct_alice
    direct_vm.value = 0
    contract.withdraw()
    # Second withdraw has nothing left to pull.
    with direct_vm.expect_revert("[EXPECTED] No claimable bounty balance to withdraw"):
        contract.withdraw()


# ---------------------------------------------------------------------------
# Consensus credits claimable, never pushes (pull-over-push)
# ---------------------------------------------------------------------------

def test_consensus_credits_do_not_move_before_withdraw(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    _submit(contract, pool_id, title="Critical Oracle Skew Drains Vault",
            verdict_mock=critical_ai_verdict(), direct_vm=direct_vm, sender=direct_alice)

    # Balance is owed (claimable) but still counted as locked_escrow until pulled.
    assert contract.get_claimable(direct_alice) == str(80 * ONE_GEN)
    assert json.loads(contract.get_protocol_stats())["locked_escrow"] == str(80 * ONE_GEN)


# ---------------------------------------------------------------------------
# Solvency invariant across multiple beneficiaries
# ---------------------------------------------------------------------------

def test_solvency_invariant_multiple_claims(
    direct_vm, direct_deploy, direct_bob, direct_alice, direct_charlie
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob, deposit=300, crit=80)

    # Alice: CRITICAL (80), commit A
    _submit(contract, pool_id, title="Critical Oracle Skew Drains Vault",
            verdict_mock=critical_ai_verdict(), direct_vm=direct_vm, sender=direct_alice,
            commit=COMMIT_A)
    # Charlie: HIGH (40), commit B (distinct fingerprint)
    direct_vm.clear_mocks()
    _submit(contract, pool_id, title="High Severity Signature Replay",
            verdict_mock=high_ai_verdict(), direct_vm=direct_vm, sender=direct_charlie,
            commit=COMMIT_B)

    alice_claim = int(contract.get_claimable(direct_alice))
    charlie_claim = int(contract.get_claimable(direct_charlie))
    stats = json.loads(contract.get_protocol_stats())
    locked = int(stats["locked_escrow"])
    total_deposited = int(stats["total_deposited"])

    assert alice_claim == 80 * ONE_GEN
    assert charlie_claim == 40 * ONE_GEN
    # Invariant 1: locked_escrow == sum of all claimable balances.
    assert locked == alice_claim + charlie_claim
    # Invariant 2: locked_escrow can never exceed total_deposited.
    assert locked <= total_deposited

    # After both withdraw, locked returns to zero, invariant holds.
    direct_vm.sender = direct_alice; direct_vm.value = 0
    contract.withdraw()
    direct_vm.sender = direct_charlie; direct_vm.value = 0
    contract.withdraw()
    stats = json.loads(contract.get_protocol_stats())
    assert stats["locked_escrow"] == "0"
    assert int(stats["locked_escrow"]) <= int(stats["total_deposited"])


# ---------------------------------------------------------------------------
# Transient fault tolerance: HTTP 429 reverts with [TRANSIENT]
# ---------------------------------------------------------------------------

def test_rate_limit_429_reverts_transient(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    mock_source(direct_vm, "rate limited", status=429)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("[TRANSIENT]"):
        contract.submit_vulnerability(
            pool_id, "Critical Oracle Skew Drains Vault", "Oracle Manipulation",
            "MarginEngine.sol", REPO, COMMIT_A, FILE_PATH, POC, "impact",
        )
    # No escrow moved on a transient failure.
    assert contract.get_claimable(direct_alice) == "0"
    assert json.loads(contract.get_protocol_stats())["locked_escrow"] == "0"


def test_server_error_500_reverts_transient(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    mock_source(direct_vm, "upstream down", status=503)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("[TRANSIENT]"):
        contract.submit_vulnerability(
            pool_id, "Critical Oracle Skew Drains Vault", "Oracle Manipulation",
            "MarginEngine.sol", REPO, COMMIT_A, FILE_PATH, POC, "impact",
        )


# ---------------------------------------------------------------------------
# Malformed LLM output reverts with [LLM_ERROR] (no node crash)
# ---------------------------------------------------------------------------

def test_malformed_llm_output_reverts_llm_error(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)
    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    # A JSON array (not an object) is a well-formed but non-conforming response.
    direct_vm.mock_llm(AI_PROMPT_PATTERN, "[1, 2, 3]")
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("[LLM_ERROR]"):
        contract.submit_vulnerability(
            pool_id, "Critical Oracle Skew Drains Vault", "Oracle Manipulation",
            "MarginEngine.sol", REPO, COMMIT_A, FILE_PATH, POC, "impact",
        )
    assert contract.get_claimable(direct_alice) == "0"
