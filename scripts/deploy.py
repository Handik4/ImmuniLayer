#!/usr/bin/env python3
"""
ImmuniLayer Deployment Validator

Validates contract.py before deployment to a GenLayer network. Actual
deployment is performed with the GenLayer CLI (see scripts/deploy.sh) or from
the frontend via genlayer-js. This script verifies the pinned runner hash and
reports basic contract metrics.
"""

import sys
import os


def main():
    print("========================================================")
    print("ImmuniLayer Deployment Validator")
    print("========================================================")

    contract_path = os.path.join(os.path.dirname(__file__), "..", "contract.py")
    contract_path = os.path.abspath(contract_path)

    if not os.path.exists(contract_path):
        print(f"Error: Contract file not found at {contract_path}")
        sys.exit(1)

    with open(contract_path, "r", encoding="utf-8") as f:
        code = f.read()

    # Verify pinned runner
    first_line = code.split("\n")[0].strip()
    runner = "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6"
    if runner not in first_line:
        print(f"Error: Contract header must pin runner hash {runner}")
        sys.exit(1)

    print(f"OK: Pinned runner hash verified: {first_line}")
    print(f"OK: Code length: {len(code.splitlines())} lines ({len(code)} bytes)")
    print("OK: Contract is ready for deployment.")
    print("Next: deploy with 'genlayer deploy --contract contract.py' (see scripts/deploy.sh)")
    print("========================================================")


if __name__ == "__main__":
    main()
