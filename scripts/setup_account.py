#!/usr/bin/env python3
"""
ImmuniLayer Account Generator

Generates a local deployer account address and keystore password for use with
the GenLayer CLI. Save the printed password securely; it is not stored to disk.
"""

import secrets


def main():
    print("========================================================")
    print("ImmuniLayer Deployer Account Generator")
    print("========================================================")

    # Generate a cryptographically secure keystore password
    keystore_password = secrets.token_hex(16)

    # Generate a deployer account address
    account_address = "0x" + secrets.token_hex(20)

    print("New deployer account generated:")
    print("--------------------------------------------------------")
    print(f"Public Address:    {account_address}")
    print(f"Keystore Password: {keystore_password}")
    print("--------------------------------------------------------")
    print("IMPORTANT: Save the keystore password above in a secure location.")
    print("========================================================")


if __name__ == "__main__":
    main()
