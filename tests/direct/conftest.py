"""
ImmuniLayer Protocol - Direct Test Configuration

Fixtures direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie,
direct_owner, and direct_accounts are auto-provided by the gltest_direct
pytest plugin (loaded via genlayer-test entry point). No redefinition needed.

CONTRACT_PATH is shared so every test module can import the same file path.

Ground-truth verification: submit_vulnerability now retrieves the target source
from raw.githubusercontent.com during the non-deterministic phase. Every test
that submits a report must therefore register BOTH an LLM mock and a web mock
(via direct_vm.mock_web) so the leader/validator retrieval is deterministic and
offline. Helpers below centralize that wiring.
"""

from pathlib import Path
import json
import pytest

CONTRACT_PATH = Path(__file__).parent.parent.parent / "contract.py"

ONE_GEN = 10**18  # 1 GEN in wei (atto scale)

# Regex matching the raw GitHub fetch the contract performs. Used as the URL
# pattern for direct_vm.mock_web so the retrieval is intercepted in tests.
RAW_GITHUB_URL_PATTERN = r".*raw\.githubusercontent\.com/.*"

# A representative "real" target source that DOES contain the vulnerable
# function referenced by the exploit PoCs used across the suite.
VULNERABLE_TARGET_SOURCE = """
// MarginEngine.sol
pragma solidity ^0.8.19;

contract MarginEngine {
    function computeCollateralRatio(address user) public view returns (uint256) {
        uint256 price = spotOracle.getPrice(collateralToken); // spot price, manipulable
        return (collateralOf[user] * price) / debtOf[user];
    }

    function borrowMaxStablecoins() external returns (uint256) {
        uint256 ratio = computeCollateralRatio(msg.sender);
        // vulnerable: trusts spot oracle skewable via flashloan
        return _mintAgainstRatio(ratio);
    }
}
"""

# A "real" target source that does NOT contain the claimed vulnerable function,
# used to exercise source-mismatch rejection.
UNRELATED_TARGET_SOURCE = """
// Router.sol
pragma solidity ^0.8.19;

contract Router {
    function swapExactTokensForTokens(uint256 amountIn) external returns (uint256) {
        return _executeSwap(amountIn);
    }
}
"""


def mock_source(direct_vm, body: str, status: int = 200):
    """Mock the raw GitHub source retrieval the contract performs.

    Registers a web mock keyed on the raw.githubusercontent.com URL so both the
    leader and (on run_validator) the validator receive the same source body.
    """
    direct_vm.mock_web(RAW_GITHUB_URL_PATTERN, {"status": status, "body": body})


def critical_ai_verdict():
    """Return a JSON-string mocking a CRITICAL, source-verified verdict."""
    return json.dumps({
        "source_verified": True,
        "tier": "CRITICAL",
        "score": 97,
        "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
        "exploitability": "HIGH",
        "summary": "Flashloan oracle skew enables unbacked borrow extraction.",
        "recommended_fix": "Replace spot price oracle with time-weighted TWAP."
    })


def high_ai_verdict():
    return json.dumps({
        "source_verified": True,
        "tier": "HIGH",
        "score": 82,
        "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:L",
        "exploitability": "HIGH",
        "summary": "Signature replay across chains drains bridge reserves.",
        "recommended_fix": "Bind signatures to chain ID and per-recipient nonce."
    })


def medium_ai_verdict():
    return json.dumps({
        "source_verified": True,
        "tier": "MEDIUM",
        "score": 58,
        "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:L",
        "exploitability": "MEDIUM",
        "summary": "Read-only reentrancy in Curve gauge inflates collateral.",
        "recommended_fix": "Add nonreentrant guard on get_virtual_price callers."
    })


def low_ai_verdict():
    return json.dumps({
        "source_verified": True,
        "tier": "LOW",
        "score": 24,
        "cvss_vector": "CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:N/I:L/A:N",
        "exploitability": "LOW",
        "summary": "Minor rounding leakage on fee accrual path.",
        "recommended_fix": "Round fee accrual toward the protocol."
    })


def rejected_ai_verdict():
    """Report is well-formed but the exploit is not reproducible / spam."""
    return json.dumps({
        "source_verified": True,
        "tier": "REJECTED",
        "score": 3,
        "cvss_vector": "N/A",
        "exploitability": "LOW",
        "summary": "Report lacks any reproducible exploit path.",
        "recommended_fix": "N/A"
    })


def source_mismatch_verdict():
    """The claimed vulnerable function is absent from the retrieved source."""
    return json.dumps({
        "source_verified": False,
        "tier": "REJECTED",
        "score": 2,
        "cvss_vector": "N/A",
        "exploitability": "LOW",
        "summary": "Targeted function not present in the retrieved revision.",
        "recommended_fix": "N/A"
    })


# Backwards-compatible alias used by a few older tests.
def invalid_ai_verdict():
    return rejected_ai_verdict()


@pytest.fixture
def bounty_contract(direct_vm, direct_deploy, direct_bob):
    """
    Deploy a fresh ImmuniLayer contract and create one funded pool as Bob.
    Returns (contract, pool_id).
    """
    contract = direct_deploy(str(CONTRACT_PATH))

    direct_vm.sender = direct_bob
    direct_vm.value = 200 * ONE_GEN

    pool_id = contract.create_bounty_pool(
        "Nexus DeFi Bridge",
        "https://github.com/nexus-core/bridge",
        "Cross-chain message passing and token bridge contracts",
        80 * ONE_GEN,   # max_critical (escrow cap)
        30 * ONE_GEN,   # max_high
        10 * ONE_GEN,   # max_medium
        2 * ONE_GEN,    # max_low
    )

    return contract, pool_id
