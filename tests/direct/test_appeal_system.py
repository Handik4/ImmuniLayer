"""
Direct-Mode Tests: On-Chain Appeal System

Tests appeal_report using the real contract deployed via direct mode.
Covers successful appeal state transitions, re-appeal increments,
and all validation reverts.
"""

import json
import pytest
from conftest import (
    CONTRACT_PATH, ONE_GEN, critical_ai_verdict, invalid_ai_verdict,
    mock_source, VULNERABLE_TARGET_SOURCE,
)

AI_PROMPT_PATTERN = r"Principal Security Auditor"

REPO_URL = "https://github.com/nexus/bridge"
COMMIT = "abc1234def5678abc1234def5678abc1234def56"
FILE_PATH = "contracts/MarginEngine.sol"

FLASHLOAN_POC = """
def test_flashloan_drain():
    loan = Balancer.flashloan(10_000_000 * 10**18)
    skew_oracle_spot_price(loan)
    stolen = margin_vault.borrow_unbacked()
    assert stolen >= 2_000_000 * 10**18, "Exploit failed"
"""


def _deploy_and_submit(direct_vm, direct_deploy, direct_bob, direct_alice,
                       ai_verdict_json):
    """Helper: deploy contract, create pool, submit one report, return (contract, report_id)."""
    contract = direct_deploy(str(CONTRACT_PATH))

    direct_vm.sender = direct_bob
    direct_vm.value = 100 * ONE_GEN
    pool_id = contract.create_bounty_pool(
        "Nexus Bridge",
        REPO_URL,
        "Bridge contracts",
        50 * ONE_GEN, 20 * ONE_GEN, 5 * ONE_GEN, ONE_GEN,
    )

    mock_source(direct_vm, VULNERABLE_TARGET_SOURCE)
    direct_vm.mock_llm(AI_PROMPT_PATTERN, ai_verdict_json)
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    report_id = contract.submit_vulnerability(
        pool_id,
        "Critical Flashloan Oracle Skew Attack",
        "Oracle Manipulation",
        "MarginEngine.sol",
        REPO_URL,
        COMMIT,
        FILE_PATH,
        FLASHLOAN_POC,
        "Attacker extracts $2M unbacked stablecoins.",
    )

    return contract, report_id


# ---------------------------------------------------------------------------
# Successful appeal
# ---------------------------------------------------------------------------

def test_appeal_rejected_report_success(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, report_id = _deploy_and_submit(
        direct_vm, direct_deploy, direct_bob, direct_alice,
        invalid_ai_verdict()
    )

    # Verify initial state is REJECTED
    report = json.loads(contract.get_report(report_id))
    assert report["status"] == "REJECTED"
    assert report["appeal_count"] == 0

    # Alice files an appeal with a substantive justification
    justification = (
        "The validator overlooked the fallback execution path in Callback.sol. "
        "The reentrancy window exists between lines 47-52 where external call "
        "precedes the state update."
    )
    ok = contract.appeal_report(report_id, justification)
    assert ok is True

    appealed = json.loads(contract.get_report(report_id))
    assert appealed["status"] == "APPEALED"
    assert appealed["appeal_count"] == 1
    assert appealed["last_appeal_reason"] == justification


def test_appeal_increments_count_on_re_appeal(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, report_id = _deploy_and_submit(
        direct_vm, direct_deploy, direct_bob, direct_alice,
        invalid_ai_verdict()
    )

    j1 = "First appeal: missed fallback execution path in Callback.sol line 47."
    contract.appeal_report(report_id, j1)

    j2 = "Second appeal: CVSS exploitability factor was incorrectly assessed as LOW."
    contract.appeal_report(report_id, j2)

    report = json.loads(contract.get_report(report_id))
    assert report["appeal_count"] == 2
    assert report["last_appeal_reason"] == j2


def test_appeal_verified_report_transitions_to_appealed(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, report_id = _deploy_and_submit(
        direct_vm, direct_deploy, direct_bob, direct_alice,
        critical_ai_verdict()
    )

    report = json.loads(contract.get_report(report_id))
    assert report["status"] == "VERIFIED"

    contract.appeal_report(
        report_id,
        "Appealing severity classification - should be HIGH not CRITICAL based on scope."
    )

    report = json.loads(contract.get_report(report_id))
    assert report["status"] == "APPEALED"


# ---------------------------------------------------------------------------
# Validation reverts
# ---------------------------------------------------------------------------

def test_appeal_nonexistent_report_reverts(direct_vm, direct_deploy):
    contract = direct_deploy(str(CONTRACT_PATH))

    with direct_vm.expect_revert("[EXPECTED] Report 999 not found"):
        contract.appeal_report(999, "Valid substantive justification text here.")


def test_appeal_short_justification_reverts(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, report_id = _deploy_and_submit(
        direct_vm, direct_deploy, direct_bob, direct_alice,
        invalid_ai_verdict()
    )

    with direct_vm.expect_revert("[EXPECTED] Substantive appeal justification required"):
        contract.appeal_report(report_id, "too short")


def test_appeal_empty_justification_reverts(
    direct_vm, direct_deploy, direct_bob, direct_alice
):
    contract, report_id = _deploy_and_submit(
        direct_vm, direct_deploy, direct_bob, direct_alice,
        invalid_ai_verdict()
    )

    with direct_vm.expect_revert("[EXPECTED] Substantive appeal justification required"):
        contract.appeal_report(report_id, "   ")
