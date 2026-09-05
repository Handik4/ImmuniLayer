# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *
import json
import re

# Error class prefixes for validator error equivalence classification
ERROR_EXPECTED = "[EXPECTED]"    # Business logic violations (deterministic)
ERROR_EXTERNAL = "[EXTERNAL]"    # External endpoint failures (deterministic)
ERROR_TRANSIENT = "[TRANSIENT]"  # Network/5xx failures (temporary)
ERROR_LLM = "[LLM_ERROR]"        # Non-compliant LLM formatting or parsing failure

# =============================================================================
# EXACT PAYOUT TIER SCHEMA
# =============================================================================
# Validators must reach consensus on ONE of these categorical tiers. The payout
# is a fixed percentage of the pool's escrow cap (expressed in basis points to
# keep the calculation exact and deterministic - no floating point). This
# removes any arbitrary/continuous payout computation from the settlement path.
#
#   CRITICAL -> 100% of cap    HIGH -> 50%    MEDIUM -> 20%    LOW -> 5%
#   REJECTED -> 0% (no value leaves escrow)
TIER_BPS = {
    "CRITICAL": 10000,
    "HIGH": 5000,
    "MEDIUM": 2000,
    "LOW": 500,
    "REJECTED": 0,
}
VALID_TIERS = ("CRITICAL", "HIGH", "MEDIUM", "LOW", "REJECTED")

# Cap the retrieved target source that is fed to the LLM so a large file cannot
# blow up the prompt. This is applied identically by leader and validators so it
# stays deterministic across the quorum.
MAX_SOURCE_CHARS = 12000


def _normalize_signature_input(text: str) -> str:
    """Collapse all whitespace and lowercase so trivial reformatting of an
    identical exploit still collapses to the same replay signature."""
    return re.sub(r"\s+", "", (text or "")).lower()


def _extract_repo_slug(repo_url: str) -> str:
    """Extract the ``owner/name`` slug from a GitHub repository URL.

    ``https://github.com/nexus-core/bridge`` -> ``nexus-core/bridge``
    Trailing ``.git`` and slashes are stripped. Deterministic string parsing
    only - safe to run in the deterministic path and inside the nondet block.
    """
    slug = (repo_url or "").strip()
    matched = False
    for prefix in ("https://github.com/", "http://github.com/",
                   "https://www.github.com/", "github.com/"):
        if slug.startswith(prefix):
            slug = slug[len(prefix):]
            matched = True
            break
    if not matched:
        # Only GitHub-hosted repositories can be ground-truth verified via the
        # raw.githubusercontent.com retrieval path.
        return ""
    slug = slug.strip("/")
    if slug.endswith(".git"):
        slug = slug[:-4]
    parts = [p for p in slug.split("/") if p]
    if len(parts) < 2:
        return ""
    return f"{parts[0]}/{parts[1]}"


@gl.evm.contract_interface
class _Payable:
    """
    Minimal external-account interface used to move native GEN out of the
    contract escrow to a researcher (EOA) or back to a pool owner. Sending
    to an address on the GenLayer chain is an external message, so it uses
    the EVM contract interface even when the recipient is a plain account.
    """

    class View:
        pass

    class Write:
        pass


class ImmuniLayerBugBounty(gl.Contract):
    """
    ImmuniLayer Protocol - Autonomous Bug Bounty and Exploit Verification

    A decentralized security bounty protocol on GenLayer.
    - Projects establish bounty pools backed by real on-chain GEN escrow.
    - Whitehat researchers submit vulnerability reports with Proof-of-Concept
      (PoC) code.
    - GenLayer AI Validators perform sandboxed sanity checks and threat
      modeling, reaching consensus on severity (CRITICAL, HIGH, MEDIUM, LOW,
      INVALID).
    - On a VERIFIED verdict the contract settles value: it transfers the tiered
      bounty in native GEN from escrow directly to the researcher.
    - On a REJECTED verdict no value leaves escrow; the funds remain locked for
      the protocol (an implicit refund), and the owner can withdraw them.
    - All disclosures, verdicts, settlements, and telemetry are permanently
      preserved on-chain.

    Monetary amounts are handled in wei (1 GEN = 10**18 wei) and stored in the
    JSON payloads as decimal strings so client code can decode them without
    losing precision on large integers.
    """

    # Storage slot declarations
    protocol_owner: Address
    pool_count: u32
    report_count: u32
    total_bounties_paid: u256

    # -------------------------------------------------------------------------
    # Solvency accounting (native GEN, atto-scale u256).
    # total_deposited : cumulative native GEN ever deposited into escrow.
    # locked_escrow   : native GEN currently owed to researchers but not yet
    #                   withdrawn (== sum of claimable_balances at all times).
    # claimable_balances : pull-over-push ledger. Consensus ONLY credits here;
    #                   researchers pull their own funds via withdraw().
    # Invariants (checked in tests):
    #   locked_escrow == sum(claimable_balances)
    #   locked_escrow <= total_deposited
    #   locked_escrow + sum(pool.balance) == contract native balance (minus
    #     any owner escrow refunds), i.e. the contract is always solvent.
    # -------------------------------------------------------------------------
    total_deposited: u256
    locked_escrow: u256
    claimable_balances: TreeMap[Address, u256]

    # Pools: pool_id -> JSON string
    # Schema: { "id": int, "name": str, "repo_url": str, "description": str,
    #           "balance": str(wei), "max_critical": str(wei),
    #           "max_high": str(wei), "max_medium": str(wei),
    #           "max_low": str(wei), "owner": str, "is_active": bool }
    pools: TreeMap[u32, str]

    # Reports: report_id -> JSON string
    reports: TreeMap[u32, str]

    # Replay / double-claim protection.
    # Maps a collision-resistant submission fingerprint -> True once that exact
    # disclosure against that exact revision has been processed. The key is the
    # u256 integer form of Keccak256(repo_url + commit_hash + file_path +
    # vuln_id). A second attempt with the same fingerprint reverts before any
    # escrow is credited.
    processed_submissions: TreeMap[u256, bool]

    # Historical indexes
    report_index: DynArray[u32]
    pool_index: DynArray[u32]

    def __init__(self):
        self.protocol_owner = gl.message.sender_address
        self.pool_count = u32(0)
        self.report_count = u32(0)
        self.total_bounties_paid = u256(0)
        self.total_deposited = u256(0)
        self.locked_escrow = u256(0)

    # =========================================================================
    # BOUNTY POOL MANAGEMENT (REAL ESCROW)
    # =========================================================================

    @gl.public.write.payable
    def create_bounty_pool(
        self,
        name: str,
        repo_url: str,
        description: str,
        max_critical: u256,
        max_high: u256,
        max_medium: u256,
        max_low: u256
    ) -> u32:
        """
        Create a new project bounty pool with custom severity reward caps.

        The initial escrow deposit is the native GEN sent with this call
        (gl.message.value). The value is locked in the contract balance and
        becomes the pool's withdrawable/payable escrow.
        """
        deposit = gl.message.value
        if deposit == u256(0):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} A non-zero GEN escrow deposit is required to open a pool")
        if not name or len(name.strip()) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Pool name cannot be empty")
        if not repo_url or not repo_url.startswith("http"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Valid repository URL is required")
        if max_critical < max_high or max_high < max_medium or max_medium < max_low:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Severity caps must follow CRITICAL >= HIGH >= MEDIUM >= LOW hierarchy")

        self.pool_count = u32(self.pool_count + u32(1))
        pool_id = self.pool_count
        owner_addr = str(gl.message.sender_address)

        pool_data = {
            "id": int(pool_id),
            "name": name.strip(),
            "repo_url": repo_url.strip(),
            "description": description.strip(),
            "balance": str(int(deposit)),
            "max_critical": str(int(max_critical)),
            "max_high": str(int(max_high)),
            "max_medium": str(int(max_medium)),
            "max_low": str(int(max_low)),
            "owner": owner_addr,
            "is_active": True
        }

        self.pools[pool_id] = json.dumps(pool_data)
        self.pool_index.append(pool_id)

        # Solvency accounting: record the native GEN now held in escrow.
        self.total_deposited = u256(self.total_deposited + deposit)
        return pool_id

    @gl.public.write.payable
    def deposit_bounty_funds(self, pool_id: u32) -> str:
        """
        Top-up escrow funds in an existing bounty pool with native GEN.
        The amount is the value sent with the call (gl.message.value).
        Returns the new pool balance in wei as a decimal string.
        """
        amount = gl.message.value
        if pool_id not in self.pools:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Pool ID {pool_id} does not exist")
        if amount <= u256(0):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Deposit amount must be positive")

        pool = json.loads(self.pools[pool_id])
        new_balance = int(pool["balance"]) + int(amount)
        pool["balance"] = str(new_balance)
        pool["is_active"] = True
        self.pools[pool_id] = json.dumps(pool)

        # Solvency accounting: cumulative native GEN deposited.
        self.total_deposited = u256(self.total_deposited + amount)
        return str(new_balance)

    @gl.public.write.payable
    def deposit(self, pool_id: u32) -> str:
        """
        Alias of deposit_bounty_funds for the canonical Sponsor funding flow:
        a Protocol Sponsor funds an existing bounty pool with native GEN via a
        single payable deposit(). Returns the new pool balance (wei string).
        """
        return self.deposit_bounty_funds(pool_id)

    @gl.public.write
    def withdraw_pool_funds(self, pool_id: u32) -> str:
        """
        Return the remaining escrow of a pool to its owner (protocol refund).

        Only the pool owner may withdraw. This is the path a protocol uses to
        reclaim unpaid escrow, including after reports are rejected and no
        payout was settled. Transfers the full remaining balance in native GEN.
        """
        if pool_id not in self.pools:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Pool ID {pool_id} does not exist")

        pool = json.loads(self.pools[pool_id])
        caller = str(gl.message.sender_address)
        if caller != pool["owner"]:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only the pool owner can withdraw escrow")

        remaining = int(pool["balance"])
        if remaining <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Pool escrow is already empty")

        pool["balance"] = "0"
        pool["is_active"] = False
        self.pools[pool_id] = json.dumps(pool)

        # Real value settlement: send the escrow back to the owner (EOA).
        _Payable(gl.message.sender_address).emit_transfer(value=u256(remaining))
        return str(remaining)

    # =========================================================================
    # PULL-OVER-PUSH BENEFICIARY WITHDRAWAL
    # =========================================================================

    @gl.public.write
    def withdraw(self) -> str:
        """
        Beneficiary pull: a Verified Beneficiary withdraws the native GEN
        credited to them by consensus. Follows strict Checks-Effects-Interactions
        so the external transfer happens only after state is fully updated.

        Consensus never pushes value; every payout is claimed here. Returns the
        withdrawn amount in wei as a decimal string.
        """
        beneficiary = gl.message.sender_address

        # --- Checks
        amount = int(self.claimable_balances.get(beneficiary, u256(0)))
        if amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No claimable bounty balance to withdraw")

        # --- Effects (zero out before the interaction to prevent re-entrancy)
        self.claimable_balances[beneficiary] = u256(0)
        self.locked_escrow = u256(self.locked_escrow - u256(amount))

        # --- Interaction
        _Payable(beneficiary).emit_transfer(value=u256(amount))
        return str(amount)

    # =========================================================================
    # VULNERABILITY SUBMISSION, AI CONSENSUS, AND SETTLEMENT
    # =========================================================================

    @gl.public.write
    def submit_vulnerability(
        self,
        pool_id: u32,
        title: str,
        vuln_type: str,
        target_component: str,
        repo_url: str,
        commit_hash: str,
        file_path: str,
        poc_code: str,
        impact_description: str
    ) -> u32:
        """
        Submit a security vulnerability report bound to a specific target
        revision.

        The report must identify the exact target source to audit against:
        - ``repo_url``     GitHub repository URL (e.g. https://github.com/org/repo)
        - ``commit_hash``  The exact commit/ref the exploit targets
        - ``file_path``    Path within the repo to the vulnerable file

        Evaluation is grounded in the ACTUAL target source: during the
        non-deterministic phase the leader and every validator independently
        retrieve the raw file at that revision and the LLM is required to
        confirm the vulnerable function/logic genuinely exists there before any
        payout is authorized. Validators must additionally reach consensus on
        the EXACT categorical payout tier. A collision-resistant fingerprint of
        the disclosure guarantees the same exploit against the same revision can
        never be settled twice (replay / double-claim protection).
        """
        if pool_id not in self.pools:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Bounty pool {pool_id} does not exist")
        if not title or len(title.strip()) < 5:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Title must be at least 5 characters")
        if not poc_code or len(poc_code.strip()) < 10:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Meaningful Proof-of-Concept code or exploit payload is required")

        # --- Target revision metadata is mandatory: no ground truth, no payout.
        repo_url = (repo_url or "").strip()
        commit_hash = (commit_hash or "").strip()
        file_path = (file_path or "").strip().lstrip("/")
        if not repo_url.startswith("http"):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} A valid target repository URL is required")
        repo_slug = _extract_repo_slug(repo_url)
        if not repo_slug:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Repository URL must be a GitHub owner/repo target")
        if len(commit_hash) < 7:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} A specific target commit hash (>= 7 chars) is required")
        if not file_path:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} A target file path within the repository is required")

        pool = json.loads(self.pools[pool_id])
        pool_balance = int(pool["balance"])
        if not pool.get("is_active", True) or pool_balance <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Target bounty pool has zero active balance")

        researcher_addr = str(gl.message.sender_address)

        # ---------------------------------------------------------------------
        # Replay / double-claim protection (deterministic state).
        # The fingerprint binds the target revision AND the exploit content, so
        # the same disclosure against the same file@commit can only ever be
        # processed once. Computed and checked BEFORE any escrow is released.
        # ---------------------------------------------------------------------
        # vuln_id is the content identity of the exploit: normalized so trivial
        # reformatting of an identical report still collapses to the same id.
        vuln_id = _normalize_signature_input(
            vuln_type + "|" + target_component + "|" + poc_code
        )
        fingerprint_source = (
            repo_url + "|" + commit_hash + "|" + file_path + "|" + vuln_id
        )
        submission_hash_hex = Keccak256(fingerprint_source.encode("utf-8")).hexdigest()
        # u256 key form: Keccak256 is 256 bits so the integer fits exactly.
        submission_hash = u256(int(submission_hash_hex, 16))

        if self.processed_submissions.get(submission_hash, False):
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} Duplicate submission: this exploit against "
                f"{repo_slug}@{commit_hash[:12]}/{file_path} has already been processed"
            )

        # Deterministic raw-source URL both leader and validators will retrieve.
        raw_source_url = (
            f"https://raw.githubusercontent.com/{repo_slug}/{commit_hash}/{file_path}"
        )

        # ---------------------------------------------------------------------
        # Non-Deterministic Evaluation with Equivalence Principle
        # ---------------------------------------------------------------------
        def evaluate_security_report():
            # Step 1: Retrieve the ACTUAL target source at the claimed revision.
            #         Each node fetches independently; the LLM is grounded in
            #         this real code rather than the researcher's claim alone.
            try:
                resp = gl.nondet.web.get(raw_source_url)
            except Exception as web_err:
                # Network-level failure is transient: allow consensus rotation
                # instead of permanently rejecting a possibly valid report.
                raise gl.vm.UserError(f"{ERROR_TRANSIENT} Target source retrieval failed: {web_err}")

            status = int(getattr(resp, "status", 0))
            body = getattr(resp, "body", None)
            if status >= 500 or status == 429:
                raise gl.vm.UserError(f"{ERROR_TRANSIENT} Target source host returned {status}")

            if status == 200 and body:
                try:
                    source_code = body.decode("utf-8", errors="replace")
                except Exception:
                    source_code = ""
                source_available = len(source_code.strip()) > 0
            else:
                # 404 / empty: the claimed file does not exist at that revision.
                # This is deterministic ground truth, not a transient error.
                source_code = ""
                source_available = False

            source_excerpt = source_code[:MAX_SOURCE_CHARS]

            # Step 2: Static PoC structure check (deterministic, no external I/O)
            poc_meta = {
                "has_functions": bool(re.search(r"def |function |fn ", poc_code)),
                "has_assertions_or_calls": bool(re.search(r"assert|expect|call|send|post|exec", poc_code)),
                "loc": len([line for line in poc_code.split("\n") if line.strip()]),
            }

            # Step 3: GenLayer AI Threat Model grounded in the retrieved source.
            prompt = f"""
            You are a Principal Security Auditor and Vulnerability Evaluator on the ImmuniLayer Consensus Protocol.

            You are given a researcher's vulnerability claim AND the ACTUAL target
            source code retrieved from the exact revision under audit. Your job is
            to verify the exploit against ground truth, NOT to trust the claim.

            TARGET BOUNTY REPOSITORY: {pool.get('name')} ({repo_slug})
            TARGET REVISION (COMMIT): {commit_hash}
            TARGET FILE: {file_path}
            TARGET COMPONENT / FUNCTION: {target_component}
            REPORT TITLE: {title}
            VULNERABILITY TYPE: {vuln_type}

            RETRIEVED TARGET SOURCE (source_available={source_available}):
            ```
            {source_excerpt if source_available else "<< SOURCE NOT FOUND AT THIS REVISION / PATH >>"}
            ```

            RESEARCHER IMPACT CLAIM:
            {impact_description[:2000]}

            RESEARCHER PROOF OF CONCEPT (PoC) / EXPLOIT PAYLOAD:
            ```
            {poc_code[:3000]}
            ```

            STATIC POC TELEMETRY:
            - Lines of Code: {poc_meta.get('loc')}
            - Contains test/exploit assertions: {poc_meta.get('has_assertions_or_calls')}

            TASKS:
            1. FIRST verify grounding: does the vulnerable function/logic referenced
               by the PoC and TARGET COMPONENT genuinely exist in the RETRIEVED
               TARGET SOURCE above? If the source was not found, or the targeted
               function/logic is absent, set "source_verified" to false.
            2. If (and only if) source_verified is true, decide whether the PoC
               demonstrates a genuine, reproducible exploit of that code.
            3. Assign the EXACT payout tier: one of 'CRITICAL', 'HIGH', 'MEDIUM',
               'LOW', or 'REJECTED'. Use 'REJECTED' whenever source_verified is
               false, the report is spam, or the exploit is not reproducible.
            4. Score 0-100 (CRITICAL 90-100, HIGH 70-89, MEDIUM 40-69, LOW 10-39,
               REJECTED 0-9) and give concise justification + recommended fix.

            Return STRICTLY valid JSON formatted as:
            {{
                "source_verified": true,
                "tier": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "REJECTED",
                "score": 85,
                "cvss_vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
                "exploitability": "HIGH" | "MEDIUM" | "LOW",
                "summary": "Concise summary of the verified vulnerability and impact",
                "recommended_fix": "Recommended developer patch"
            }}
            """

            raw_ai = gl.nondet.exec_prompt(prompt, response_format="json")

            # Parse and clean JSON defensively
            if isinstance(raw_ai, str):
                first = raw_ai.find("{")
                last = raw_ai.rfind("}")
                if first != -1 and last != -1:
                    clean_str = raw_ai[first:last + 1]
                    clean_str = re.sub(r",(?!\s*?[\{\[\"\'\w])", "", clean_str)
                    raw_ai = json.loads(clean_str)
                else:
                    raise gl.vm.UserError(f"{ERROR_LLM} Failed to parse JSON envelope")

            if not isinstance(raw_ai, dict):
                raise gl.vm.UserError(f"{ERROR_LLM} Non-dict response from AI evaluator")

            # Normalization to the strict tier enum. Accept legacy "severity"
            # ("INVALID") too, mapping it onto the REJECTED tier.
            tier = str(raw_ai.get("tier", raw_ai.get("severity", "REJECTED"))).upper().strip()
            if tier == "INVALID":
                tier = "REJECTED"
            if tier not in VALID_TIERS:
                tier = "REJECTED"

            # Grounding gate: if the source could not be verified, no payout tier
            # is allowed regardless of what the LLM proposed.
            source_verified = bool(raw_ai.get("source_verified", False))
            if not source_verified:
                tier = "REJECTED"

            verdict = "VERIFIED" if tier != "REJECTED" else "REJECTED"
            score = int(raw_ai.get("score", 0)) if str(raw_ai.get("score", "0")).isdigit() else 0
            summary = str(raw_ai.get("summary", "Automated threat evaluation complete."))
            fix = str(raw_ai.get("recommended_fix", "Review component bounds."))

            return {
                "verdict": verdict,
                "tier": tier,
                "source_verified": source_verified,
                "score": score,
                "summary": summary,
                "recommended_fix": fix
            }

        # Step 4: Comparative Principle - validators must agree on the EXACT tier.
        def validator_comparator(leader_result: gl.vm.Result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                # Error classification handler
                leader_msg = getattr(leader_result, "message", "")
                try:
                    evaluate_security_report()
                    return False
                except gl.vm.UserError as e:
                    val_msg = getattr(e, "message", str(e))
                    if val_msg.startswith(ERROR_EXPECTED) or val_msg.startswith(ERROR_EXTERNAL):
                        return val_msg == leader_msg
                    if val_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
                        return True
                    return False
                except Exception:
                    return False

            validator_eval = evaluate_security_report()
            leader_eval = leader_result.calldata

            # Must agree on verdict (VERIFIED vs REJECTED)
            if leader_eval.get("verdict") != validator_eval.get("verdict"):
                return False

            # Exact categorical tier consensus - NO adjacent-tier tolerance.
            # The tier directly determines how much escrow is released, so the
            # quorum must agree on the precise payout bucket.
            if leader_eval.get("tier") != validator_eval.get("tier"):
                return False

            return True

        ai_assessment = gl.vm.run_nondet_unsafe(evaluate_security_report, validator_comparator)

        # ---------------------------------------------------------------------
        # Exact tier -> deterministic payout (percentage of the escrow cap).
        # ---------------------------------------------------------------------
        tier = ai_assessment.get("tier", "REJECTED")
        if tier not in VALID_TIERS:
            tier = "REJECTED"

        escrow_cap = int(pool.get("max_critical", "0"))
        tier_bps = TIER_BPS.get(tier, 0)
        tier_amount = (escrow_cap * tier_bps) // 10000
        payout = min(pool_balance, tier_amount)

        # Pull-over-push settlement: consensus NEVER performs an external
        # transfer. It only moves value from the pool's free escrow into the
        # researcher's claimable balance and the global locked_escrow ledger.
        # The researcher later pulls the funds via withdraw() (CEI).
        if payout > 0:
            pool["balance"] = str(pool_balance - payout)
            self.pools[pool_id] = json.dumps(pool)
            self.total_bounties_paid = u256(self.total_bounties_paid + u256(payout))

            researcher = gl.message.sender_address
            prior = self.claimable_balances.get(researcher, u256(0))
            self.claimable_balances[researcher] = u256(prior + u256(payout))
            self.locked_escrow = u256(self.locked_escrow + u256(payout))

        # Record the fingerprint so this exact disclosure cannot be replayed.
        self.processed_submissions[submission_hash] = True

        self.report_count = u32(self.report_count + u32(1))
        report_id = self.report_count

        report_data = {
            "id": int(report_id),
            "pool_id": int(pool_id),
            "pool_name": pool.get("name"),
            "researcher": researcher_addr,
            "title": title.strip(),
            "vuln_type": vuln_type.strip(),
            "target_component": target_component.strip(),
            "repo_url": repo_url,
            "repo_slug": repo_slug,
            "commit_hash": commit_hash,
            "file_path": file_path,
            "source_url": raw_source_url,
            "submission_hash": submission_hash_hex,
            "source_verified": bool(ai_assessment.get("source_verified", False)),
            "poc_code": poc_code,
            "impact_desc": impact_description.strip(),
            "severity": tier,
            "tier": tier,
            "status": ai_assessment.get("verdict", "REJECTED"),
            "score": ai_assessment.get("score", 0),
            "payout_amount": str(payout),
            "payout_bps": tier_bps,
            "summary": ai_assessment.get("summary"),
            "recommended_fix": ai_assessment.get("recommended_fix"),
            "appeal_count": 0
        }

        self.reports[report_id] = json.dumps(report_data)
        self.report_index.append(report_id)

        return report_id

    # =========================================================================
    # APPEALS AND GOVERNANCE
    # =========================================================================

    @gl.public.write
    def appeal_report(self, report_id: u32, appeal_justification: str) -> bool:
        """File an on-chain appeal against a rejected or contested verdict."""
        if report_id not in self.reports:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Report {report_id} not found")
        if not appeal_justification or len(appeal_justification.strip()) < 10:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Substantive appeal justification required")

        report = json.loads(self.reports[report_id])
        report["status"] = "APPEALED"
        report["appeal_count"] = int(report.get("appeal_count", 0)) + 1
        report["last_appeal_reason"] = appeal_justification.strip()

        self.reports[report_id] = json.dumps(report)
        return True

    # =========================================================================
    # PUBLIC VIEW QUERIES
    # =========================================================================

    @gl.public.view
    def get_pool(self, pool_id: u32) -> str:
        """Fetch details for a specific bounty pool."""
        if pool_id not in self.pools:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Pool {pool_id} does not exist")
        return self.pools[pool_id]

    @gl.public.view
    def get_report(self, report_id: u32) -> str:
        """Fetch details of a submitted vulnerability report."""
        if report_id not in self.reports:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Report {report_id} does not exist")
        return self.reports[report_id]

    @gl.public.view
    def get_protocol_stats(self) -> str:
        """Get overall protocol metrics. Monetary values are wei strings."""
        stats = {
            "total_pools": int(self.pool_count),
            "total_reports": int(self.report_count),
            "total_bounties_paid": str(int(self.total_bounties_paid)),
            "total_deposited": str(int(self.total_deposited)),
            "locked_escrow": str(int(self.locked_escrow)),
            "contract_balance": str(int(self.balance)),
            "protocol_owner": str(self.protocol_owner)
        }
        return json.dumps(stats)

    @gl.public.view
    def get_claimable(self, beneficiary: Address) -> str:
        """Return the native GEN (wei string) a beneficiary can withdraw()."""
        key = Address(beneficiary)
        return str(int(self.claimable_balances.get(key, u256(0))))

    @gl.public.view
    def get_all_pools(self) -> str:
        """Retrieve all active and archived bounty pools."""
        pool_list = []
        for i in range(len(self.pool_index)):
            pid = self.pool_index[i]
            if pid in self.pools:
                pool_list.append(json.loads(self.pools[pid]))
        return json.dumps(pool_list)

    @gl.public.view
    def get_recent_reports(self, limit: u32) -> str:
        """Retrieve latest vulnerability disclosures and verdicts."""
        reports_list = []
        total = len(self.report_index)
        count = min(int(limit), total) if limit > u32(0) else total

        # Return in reverse chronological order
        for i in range(total - 1, total - 1 - count, -1):
            if i >= 0:
                rid = self.report_index[i]
                if rid in self.reports:
                    reports_list.append(json.loads(self.reports[rid]))
        return json.dumps(reports_list)
