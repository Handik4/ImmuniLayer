"""
Direct-Mode Tests: Error Classification and Validator Equivalence Principle

Verifies the validator comparator logic used inside submit_vulnerability:
- Verdicts (VERIFIED vs REJECTED) must agree exactly.
- Payout tiers must agree EXACTLY (no adjacent-tier tolerance) - the tier
  determines how much escrow is released, so the quorum must agree on the
  precise payout bucket.
- Error prefix routing: EXPECTED/EXTERNAL exact-match, TRANSIENT agree-if-both,
  LLM always disagree to force consensus rotation.

These tests run the comparator function in isolation and then confirm the
behavior end-to-end using direct_vm.run_validator() against the live contract.
"""

import json
import pytest
from conftest import (
    CONTRACT_PATH, ONE_GEN,
    critical_ai_verdict, high_ai_verdict, rejected_ai_verdict,
    mock_source, VULNERABLE_TARGET_SOURCE,
)

# Error prefix constants mirroring the contract
ERROR_EXPECTED  = "[EXPECTED]"
ERROR_EXTERNAL  = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM       = "[LLM_ERROR]"

AI_PROMPT_PATTERN = r"Principal Security Auditor"

REPO_URL = "https://github.com/test/protocol"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
FILE_PATH = "contracts/MarginEngine.sol"

FLASHLOAN_POC = """
def test_flashloan_drain():
    loan = Balancer.flashloan(15_000_000 * 10**18)
    skew_oracle_spot_price(loan)
    stolen = margin_vault.borrow_unbacked()
    assert stolen >= 3_500_000 * 10**18, "Exploit failed"
"""


# ---------------------------------------------------------------------------
# Pure-logic validator comparator (mirrors contract validator_comparator)
# ---------------------------------------------------------------------------

def _comparator(leader: dict, validator: dict) -> bool:
    """Python mirror of the contract's validator_comparator logic.

    Exact consensus: verdict AND categorical tier must match precisely.
    """
    if leader.get("verdict") != validator.get("verdict"):
        return False
    if leader.get("tier") != validator.get("tier"):
        return False
    return True


def _error_handler(leader_msg: str, validator_msg: str) -> bool:
    """Mirror of the contract's error classification handler."""
    if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
        return validator_msg == leader_msg
    if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
        return True
    if validator_msg.startswith(ERROR_LLM) or leader_msg.startswith(ERROR_LLM):
        return False  # Force rotation
    return False


# ---------------------------------------------------------------------------
# Comparator unit tests (no contract needed)
# ---------------------------------------------------------------------------

def test_exact_critical_consensus():
    l = {"verdict": "VERIFIED", "tier": "CRITICAL", "score": 95}
    v = {"verdict": "VERIFIED", "tier": "CRITICAL", "score": 92}
    assert _comparator(l, v) is True


def test_exact_high_consensus():
    l = {"verdict": "VERIFIED", "tier": "HIGH", "score": 82}
    v = {"verdict": "VERIFIED", "tier": "HIGH", "score": 74}
    assert _comparator(l, v) is True


def test_adjacent_critical_high_now_fails():
    # Adjacent tiers used to be tolerated; exact consensus rejects them.
    l = {"verdict": "VERIFIED", "tier": "CRITICAL", "score": 90}
    v = {"verdict": "VERIFIED", "tier": "HIGH",     "score": 85}
    assert _comparator(l, v) is False


def test_adjacent_high_medium_now_fails():
    l = {"verdict": "VERIFIED", "tier": "HIGH",   "score": 75}
    v = {"verdict": "VERIFIED", "tier": "MEDIUM", "score": 60}
    assert _comparator(l, v) is False


def test_divergent_critical_medium_fails():
    l = {"verdict": "VERIFIED", "tier": "CRITICAL", "score": 90}
    v = {"verdict": "VERIFIED", "tier": "MEDIUM",   "score": 50}
    assert _comparator(l, v) is False


def test_verdict_mismatch_verified_rejected_fails():
    l = {"verdict": "VERIFIED",  "tier": "MEDIUM",   "score": 55}
    v = {"verdict": "REJECTED",  "tier": "REJECTED", "score": 3}
    assert _comparator(l, v) is False


def test_verified_low_vs_rejected_fails():
    l = {"verdict": "VERIFIED", "tier": "LOW",      "score": 20}
    v = {"verdict": "REJECTED", "tier": "REJECTED", "score": 2}
    assert _comparator(l, v) is False


def test_both_rejected_agrees():
    l = {"verdict": "REJECTED", "tier": "REJECTED", "score": 3}
    v = {"verdict": "REJECTED", "tier": "REJECTED", "score": 5}
    assert _comparator(l, v) is True


# ---------------------------------------------------------------------------
# Error classification unit tests
# ---------------------------------------------------------------------------

def test_expected_errors_must_match_exactly():
    err = f"{ERROR_EXPECTED} Pool ID 99 does not exist"
    assert _error_handler(err, err) is True
    assert _error_handler(err, f"{ERROR_EXPECTED} Pool ID 88 does not exist") is False


def test_external_errors_must_match_exactly():
    err = f"{ERROR_EXTERNAL} API returned 404"
    assert _error_handler(err, err) is True
    assert _error_handler(err, f"{ERROR_EXTERNAL} API returned 500") is False


def test_transient_errors_agree_regardless_of_message():
    l_err = f"{ERROR_TRANSIENT} Network timeout after 5000ms"
    v_err = f"{ERROR_TRANSIENT} Connection reset by peer"
    assert _error_handler(l_err, v_err) is True


def test_llm_errors_always_disagree_to_force_rotation():
    l_err = f"{ERROR_LLM} Non-dict response from LLM"
    v_err = f"{ERROR_LLM} Key error: 'verdict'"
    assert _error_handler(l_err, v_err) is False


def test_mixed_llm_expected_disagrees():
    l_err = f"{ERROR_LLM} LLM returned empty string"
    v_err = f"{ERROR_EXPECTED} Pool ID 99 does not exist"
    assert _error_handler(l_err, v_err) is False


# ---------------------------------------------------------------------------
# End-to-end validator tests via real contract and run_validator()
# ---------------------------------------------------------------------------

def _deploy_pool(direct_vm, direct_deploy, direct_bob):
    contract = direct_deploy(str(CONTRACT_PATH))
    direct_vm.sender = direct_bob
    direct_vm.value = 200 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Test Protocol",
        REPO_URL,
        "Testing contracts",
        80 * ONE_GEN, 30 * ONE_GEN, 10 * ONE_GEN, 2 * ONE_GEN,
    )
    return contract, pool_id


def _submit(contract, pool_id):
    return contract.submit_vulnerability(
        pool_id,
        "Critical Flashloan Oracle Skew Attack",
        "Oracle Manipulation",
        "MarginEngine.sol",
        REPO_URL, COMMIT, FILE_PATH,
        FLASHLOAN_POC,
        "Oracle skew enables unbacked borrow extraction.",
    )


def test_e2e_validator_agrees_same_evaluation(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)

    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    _submit(contract, pool_id)

    # Validator sees the same source + verdict -> exact tier match -> agree
    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    agreed = direct_vm.run_validator()
    assert agreed is True


def test_e2e_validator_disagrees_on_different_tier(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)

    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    _submit(contract, pool_id)

    # Validator lands on a different tier (HIGH) -> exact consensus fails
    direct_vm.clear_mocks()
    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, high_ai_verdict())
    agreed = direct_vm.run_validator()
    assert agreed is False


def test_e2e_validator_disagrees_on_opposite_verdict(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, pool_id = _deploy_pool(direct_vm, direct_deploy, direct_bob)

    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, critical_ai_verdict())
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    _submit(contract, pool_id)

    # Validator sees REJECTED -> verdict flips VERIFIED->REJECTED -> disagree
    direct_vm.clear_mocks()
    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, rejected_ai_verdict())
    agreed = direct_vm.run_validator()
    assert agreed is False
