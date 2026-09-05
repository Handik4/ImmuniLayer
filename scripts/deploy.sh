#!/usr/bin/env bash
# =============================================================================
# ImmuniLayer Protocol - macOS & Linux Compatible Deploy Script
# Safe under bash 3.2+, zsh, and environments with strict variable checks.
# =============================================================================

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "========================================================"
echo "ImmuniLayer Contract Deployment"
echo "========================================================"

CONTRACT_FILE="$DIR/contract.py"
NETWORK_NAME="${GENLAYER_NETWORK:-studionet}"

if [ ! -f "$CONTRACT_FILE" ]; then
    echo "Error: Contract file not found at $CONTRACT_FILE"
    exit 1
fi

# Pre-deployment validation check
if command -v genvm-lint >/dev/null 2>&1; then
    echo "Validating contract AST and storage semantics with genvm-lint..."
    genvm-lint check "$CONTRACT_FILE" || {
        echo "Contract linting failed. Aborting deployment."
        exit 1
    }
fi

# Build deployment arguments safely for macOS Bash 3.2+
DEPLOY_ARGS=()

if [ -n "${ACCOUNT_NAME:-}" ]; then
    DEPLOY_ARGS+=("--account" "$ACCOUNT_NAME")
fi

if [ -n "${RPC_URL:-}" ]; then
    DEPLOY_ARGS+=("--rpc-url" "$RPC_URL")
fi

echo "Target Network: $NETWORK_NAME"
echo "Target Contract: $CONTRACT_FILE"

# Execute deployment using the GenLayer CLI if present
if command -v genlayer >/dev/null 2>&1; then
    echo "Deploying via GenLayer CLI..."
    genlayer deploy --contract "$CONTRACT_FILE" ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}
else
    echo "genlayer CLI not found. Running Python validation handler..."
    python3 "$DIR/scripts/deploy.py"
fi

echo ""
echo "========================================================"
echo "ImmuniLayer Deployment Process Complete"
echo "After deploying, set the contract address in frontend/config.js"
echo "========================================================"
