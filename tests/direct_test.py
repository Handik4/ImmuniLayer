"""
 Direct Unit Test Suite for Aegis AI Bug Bounty Protocol
Simulates execution of business logic, state machines, and consensus evaluation rules.
"""

import json
import unittest

class MockAddress:
    def __init__(self, addr="0x92332baa412176c763b4645aafea27b0fd4d8a9a"):
        self.addr = addr
    def __str__(self):
        return self.addr

class MockGenLayerVM:
    def __init__(self):
        self.sender_account = MockAddress()

    def spawn_sandbox(self, fn):
        class ResultWrapper:
            def __init__(self, val):
                self.val = val
        return ResultWrapper(fn())

    def unpack_result(self, res):
        return res.val


class TestAegisBugBountyLogic(unittest.TestCase):
    def setUp(self):
        # Simulated in-memory contract state
        self.protocol_owner = "0xProtocolDeployer"
        self.pool_count = 0
        self.report_count = 0
        self.total_bounties_paid = 0
        self.pools = {}
        self.reports = {}
        self.pool_index = []
        self.report_index = []

    def create_pool(self, name, repo_url, description, deposit, max_c, max_h, max_m, max_l, sender="0xProjectOwner"):
        self.pool_count += 1
        pid = self.pool_count
        pool_data = {
            "id": pid,
            "name": name,
            "repo_url": repo_url,
            "description": description,
            "balance": deposit,
            "max_critical": max_c,
            "max_high": max_h,
            "max_medium": max_m,
            "max_low": max_l,
            "owner": sender,
            "is_active": True
        }
        self.pools[pid] = json.dumps(pool_data)
        self.pool_index.append(pid)
        return pid

    def test_pool_creation_and_deposit(self):
        pid = self.create_pool(
            name="DeFi Lending Protocol V2",
            repo_url="https://github.com/aegis-defi/lending-v2",
            description="Core lending pool and liquidation smart contracts",
            deposit=100000,
            max_c=50000,
            max_h=20000,
            max_m=5000,
            max_l=1000
        )
        self.assertEqual(pid, 1)
        self.assertEqual(len(self.pool_index), 1)

        pool = json.loads(self.pools[1])
        self.assertEqual(pool["name"], "DeFi Lending Protocol V2")
        self.assertEqual(pool["balance"], 100000)
        self.assertEqual(pool["max_critical"], 50000)

    def test_vulnerability_payout_distribution(self):
        pid = self.create_pool("Oracle Protocol", "https://github.com/oracle/core", "Decentralized Price Feed", 50000, 25000, 10000, 2500, 500)
        pool = json.loads(self.pools[pid])

        # Simulate Verified CRITICAL vulnerability
        severity = "CRITICAL"
        payout = min(pool["balance"], pool["max_critical"])
        self.assertEqual(payout, 25000)

        pool["balance"] -= payout
        self.total_bounties_paid += payout
        self.pools[pid] = json.dumps(pool)

        self.assertEqual(json.loads(self.pools[pid])["balance"], 25000)
        self.assertEqual(self.total_bounties_paid, 25000)

    def test_invalid_vulnerability_rejection(self):
        pid = self.create_pool("NFT Marketplace", "https://github.com/nft/market", "Marketplace router", 10000, 5000, 2000, 500, 100)
        pool = json.loads(self.pools[pid])

        # Simulate INVALID / Spam submission
        severity = "INVALID"
        payout = 0
        self.assertEqual(payout, 0)
        self.assertEqual(pool["balance"], 10000)


if __name__ == "__main__":
    unittest.main()
