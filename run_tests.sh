#!/usr/bin/env bash
# =============================================================================
#  ImmuniLayer Protocol - Automated Test Suite Runner (macOS / Linux Compatible)
# =============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "========================================================"
echo " Running ImmuniLayer Test Suite on GenLayer StudioNet"
echo "========================================================"

# 1. Official GenLayer AST Lint & Validation
if command -v genvm-lint >/dev/null 2>&1; then
    echo " Step 1: Running genvm-lint on contract.py..."
    genvm-lint check "$DIR/contract.py" || {
        echo " genvm-lint check had warnings, running lint mode..."
        genvm-lint lint "$DIR/contract.py"
    }
else
    echo " genvm-lint CLI not found in PATH, skipping lint phase."
fi

# 2. Run Direct Unit Tests via Pytest (with plugin isolation)
echo ""
echo " Step 2: Running Direct Unit Tests (tests/direct/)..."
# pytest.ini disables the server-backed plugins and keeps gltest_direct, which
# provides the direct_vm / direct_deploy fixtures the suite relies on.
python3 -m pytest tests/direct/ -v

# 3. Run Scenario PoC Tests
echo ""
echo " Step 3: Running Exploit Simulation Scenarios (tests/)..."
python3 "$DIR/tests/direct_test.py"
python3 "$DIR/tests/test_scenarios.py"

echo ""
echo "========================================================"
echo " All ImmuniLayer tests passed successfully (100%)!"
echo "========================================================"
