"""
Employer Daemon — headless settlement agent for the A2A IntentPool protocol.

Publishes intents from JSON payloads, monitors on-chain events, and drives
the three-tier settlement pipeline (fast-track / optimistic / dispute).
"""

import getpass
import hashlib
import json
import os
import threading
import time
import uuid

import requests
from Crypto.Cipher import AES
from dotenv import load_dotenv
from eth_account.messages import encode_defunct
from web3 import Web3

# ── Configuration ────────────────────────────────────────────────────

_ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(_ENV_PATH)

RPC_URL          = "https://testnet-rpc.monad.xyz"
CONTRACT_ADDRESS = "0x1a8d74e1ADf1Be715e20d39ccF7637b8486b5899"

CONTRACT_ABI = [
    # Write operations
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"internalType": "string", "name": "rawJsonSchema", "type": "string"}, {"internalType": "uint256", "name": "minScore", "type": "uint256"}], "name": "publishIntent",   "outputs": [], "stateMutability": "payable",     "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}], "name": "approveAndPay",  "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}], "name": "autoSettle",     "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}], "name": "raiseDispute",   "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"internalType": "bool", "name": "approve", "type": "bool"}], "name": "verifyResult", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}], "name": "finalizeDispute","outputs": [], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}], "name": "refundAndSlash", "outputs": [], "stateMutability": "nonpayable", "type": "function"},
    # Read — intents() → IntentCore  [0-8]
    {"inputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}], "name": "intents", "outputs": [
        {"internalType": "address", "name": "employer",   "type": "address"},
        {"internalType": "address", "name": "worker",     "type": "address"},
        {"internalType": "uint256", "name": "bounty",     "type": "uint256"},
        {"internalType": "uint256", "name": "stake",      "type": "uint256"},
        {"internalType": "uint256", "name": "minScore",   "type": "uint256"},
        {"internalType": "bool",    "name": "isSolved",   "type": "bool"},
        {"internalType": "bool",    "name": "isResolved", "type": "bool"},
        {"internalType": "uint256", "name": "createdAt",  "type": "uint256"},
        {"internalType": "uint256", "name": "deadline",   "type": "uint256"}
    ], "stateMutability": "view", "type": "function"},
    # Read — intentDisputes() → IntentDispute  [0-4]
    {"inputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}], "name": "intentDisputes", "outputs": [
        {"internalType": "uint256", "name": "challengePeriodEnd", "type": "uint256"},
        {"internalType": "bool",    "name": "isDisputed",         "type": "bool"},
        {"internalType": "uint256", "name": "approveVotes",       "type": "uint256"},
        {"internalType": "uint256", "name": "rejectVotes",        "type": "uint256"},
        {"internalType": "uint256", "name": "voteDeadline",       "type": "uint256"}
    ], "stateMutability": "view", "type": "function"},
    # Events
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"indexed": True, "internalType": "address", "name": "worker", "type": "address"}, {"indexed": False, "internalType": "string", "name": "resultHash", "type": "string"}, {"indexed": False, "internalType": "string", "name": "dataUrl", "type": "string"}], "name": "IntentSolved", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"indexed": True, "internalType": "address", "name": "employer", "type": "address"}], "name": "ResultChallenged", "type": "event"},
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"indexed": False, "internalType": "bool", "name": "workerWon", "type": "bool"}, {"indexed": False, "internalType": "uint256", "name": "approveVotes", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "rejectVotes", "type": "uint256"}], "name": "DisputeResolved", "type": "event"},
]


# ── Private-key bootstrap ────────────────────────────────────────────

def load_private_key() -> str:
    """Load from env/.env, or interactively prompt on first run and persist."""
    key = os.environ.get("EMPLOYER_PRIVATE_KEY", "").strip()
    if key:
        return key

    print("\n[*] No private key detected. Starting first-run setup...\n")
    raw_key = getpass.getpass("[?] Enter Employer wallet private key (hidden): ").strip()
    raw_key = raw_key.removeprefix("0x")

    with open(_ENV_PATH, "w") as f:
        f.write(f"EMPLOYER_PRIVATE_KEY={raw_key}\n")
    os.chmod(_ENV_PATH, 0o600)
    os.environ["EMPLOYER_PRIVATE_KEY"] = raw_key

    print(f"[+] Key saved to {_ENV_PATH} (permissions 600). No prompt on next start.\n")

    key = raw_key
    del raw_key
    return key


# ── Agent ─────────────────────────────────────────────────────────────

class EmployerAgent:
    def __init__(self, private_key: str | None = None):
        self.private_key = private_key or load_private_key()

        session = requests.Session()
        session.trust_env = False
        self.w3 = Web3(Web3.HTTPProvider(RPC_URL, session=session))

        self.account  = self.w3.eth.account.from_key(self.private_key)
        self.contract = self.w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)

        self.active_intents: dict[bytes, str] = {}
        self.last_scanned_block = self.w3.eth.block_number

        print(f"[*] Employer Agent initialized | address: {self.account.address}")

    # ── Intent dispatch ──────────────────────────────────────────────

    def dispatch_intent(
        self,
        task_payload: dict,
        min_score: int = 85,
        bounty_eth: float = 0.001,
    ) -> bytes | None:
        """Publish an intent on-chain. Returns the 32-byte intent ID, or None on failure."""
        intent_id = uuid.uuid4().bytes * 2
        task_payload = {**task_payload, "timestamp": int(time.time())}
        raw_json = json.dumps(task_payload)
        bounty_wei = self.w3.to_wei(bounty_eth, "ether")

        print(f"[*] Publishing intent {intent_id.hex()[:10]}... bounty={bounty_eth} ETH")

        try:
            tx = self.contract.functions.publishIntent(
                intent_id, raw_json, min_score
            ).build_transaction({
                "from": self.account.address,
                "value": bounty_wei,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "gas": 300_000,
                "gasPrice": self.w3.eth.gas_price,
            })
            signed = self.w3.eth.account.sign_transaction(tx, private_key=self.private_key)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            self.w3.eth.wait_for_transaction_receipt(tx_hash)

            self.active_intents[intent_id] = "Pending"
            print(f"[+] Intent broadcast OK | tx: {tx_hash.hex()}")
            return intent_id
        except Exception as e:
            print(f"[!] Failed to publish intent: {e}")
            return None

    # ── x.402 + IPFS settlement ──────────────────────────────────────

    @staticmethod
    def _aes_decrypt(key: bytes, data: bytes) -> bytes:
        """AES-256-GCM decrypt. Layout: nonce(16) | tag(16) | ciphertext."""
        nonce, tag, ct = data[:16], data[16:32], data[32:]
        return AES.new(key, AES.MODE_GCM, nonce=nonce).decrypt_and_verify(ct, tag)

    def process_settlement(self, intent_id: bytes, ipfs_url: str, expected_hash: str):
        """
        Full x.402 + IPFS hybrid settlement pipeline:
          1. Download encrypted manifest from IPFS
          2. Acquire AES key via x.402 handshake with Worker gateway
          3. Decrypt payload & verify SHA-256 against on-chain attestation
          4. Persist plaintext result to local `results/` directory
          5. Call `approveAndPay` — or `raiseDispute` if hash mismatches
        """
        id_hex = intent_id.hex()
        print(f"\n[*] Intent {id_hex[:10]}... solved — initiating x.402 settlement")

        try:
            s = requests.Session()
            s.trust_env = False

            # Step 1 — IPFS manifest
            print("[IPFS]  Downloading encrypted manifest...")
            resp = s.get(ipfs_url, timeout=30)
            resp.raise_for_status()
            manifest       = resp.json()
            key_gateway    = manifest["key_gateway"]
            encrypted_data = bytes.fromhex(manifest["encrypted_data"])

            # Step 2 — x.402 key exchange
            key_url = f"{key_gateway}/{id_hex}"
            print(f"[x.402] Requesting decryption key: {key_url}")

            r1 = s.get(key_url)
            if r1.status_code != 402:
                print(f"[!] Expected 402, got {r1.status_code}. Aborting.")
                return
            print("[x.402] Received 402 challenge, signing...")

            message  = encode_defunct(text=f"Unlock_Key_{id_hex}")
            sig_hex  = self.w3.eth.account.sign_message(
                message, private_key=self.private_key
            ).signature.hex()

            r2 = s.get(key_url, headers={"Authorization": f"x402 {sig_hex}"})
            if r2.status_code != 200:
                print(f"[!] x.402 authorization failed ({r2.status_code}): {r2.text}")
                return

            aes_key = bytes.fromhex(r2.json()["key"])
            print("[x.402] Key acquired successfully")

            # Step 3 — Decrypt & verify
            print("[AES]   Decrypting content...")
            plaintext = self._aes_decrypt(aes_key, encrypted_data)
            content   = plaintext.decode("utf-8")

            actual_hash = hashlib.sha256(plaintext).hexdigest()
            if actual_hash != expected_hash:
                print(f"[!] Hash mismatch | on-chain: {expected_hash[:16]}... vs decrypted: {actual_hash[:16]}...")
                print("[!] Integrity check failed — auto-raising on-chain dispute")
                self._raise_dispute_on_chain(intent_id)
                return

            print(f"[+] Decryption & hash verification passed ({len(content)} bytes)")

            # Step 4 — Persist result locally
            results_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
            os.makedirs(results_dir, exist_ok=True)
            result_path = os.path.join(results_dir, f"{id_hex[:16]}.txt")
            with open(result_path, "w", encoding="utf-8") as f:
                f.write(content)

            print(f"[+] Result saved to: {result_path} ({len(content)} bytes)")

            # Step 5 — On-chain settlement
            tx_hash = self._send_tx(self.contract.functions.approveAndPay(intent_id))
            if tx_hash:
                self.active_intents[intent_id] = "Settled"
                print(f"[+] Funds released | tx: {tx_hash}")

        except Exception as e:
            print(f"[!] Settlement error: {e}")

    # ── Transaction helper ───────────────────────────────────────────

    def _send_tx(self, fn_call, gas: int = 150_000) -> str | None:
        """Build, sign, broadcast a contract call. Returns tx hash or None."""
        try:
            tx = fn_call.build_transaction({
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "gas": gas,
                "gasPrice": self.w3.eth.gas_price,
            })
            signed  = self.w3.eth.account.sign_transaction(tx, private_key=self.private_key)
            tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
            self.w3.eth.wait_for_transaction_receipt(tx_hash)
            return tx_hash.hex()
        except Exception as e:
            print(f"[!] Transaction failed: {e}")
            return None

    # ── Tier 3 helpers ───────────────────────────────────────────────

    def _raise_dispute_on_chain(self, intent_id: bytes):
        id_hex = intent_id.hex()
        print(f"[*] Raising on-chain dispute for {id_hex[:10]}...")
        tx_hash = self._send_tx(self.contract.functions.raiseDispute(intent_id))
        if tx_hash:
            self.active_intents[intent_id] = "Disputed"
            print(f"[+] Dispute submitted — awaiting third-party verifier votes | tx: {tx_hash}")
        else:
            print("[!] raiseDispute failed (challenge period may have expired)")

    def _try_auto_settle(self, intent_id: bytes):
        id_hex = intent_id.hex()
        print(f"[*] Challenge period elapsed for {id_hex[:10]}... — calling autoSettle")
        tx_hash = self._send_tx(self.contract.functions.autoSettle(intent_id))
        if tx_hash:
            self.active_intents[intent_id] = "Settled"
            print(f"[+] autoSettle complete — worker received bounty + stake | tx: {tx_hash}")

    def _try_finalize_dispute(self, intent_id: bytes):
        id_hex = intent_id.hex()
        print(f"[*] Vote period ended for {id_hex[:10]}... — calling finalizeDispute")
        tx_hash = self._send_tx(self.contract.functions.finalizeDispute(intent_id))
        if tx_hash:
            self.active_intents[intent_id] = "Settled"
            print(f"[+] Dispute finalized | tx: {tx_hash}")

    def _refund_expired(self, intent_id: bytes):
        id_hex = intent_id.hex()
        print(f"\n[*] Intent {id_hex[:10]}... expired — calling refundAndSlash")
        tx_hash = self._send_tx(self.contract.functions.refundAndSlash(intent_id))
        if tx_hash:
            self.active_intents[intent_id] = "Refunded"
            print(f"[+] Refund complete | tx: {tx_hash}")
        else:
            print("[!] refundAndSlash failed")

    # ── Event loop ───────────────────────────────────────────────────

    def watch_events(self):
        """
        Background poller driving the settlement state-machine:
          1. IntentSolved → start x.402 settlement  (Tier 1)
          2. Challenge period elapsed, no dispute    → autoSettle   (Tier 2)
          3. Dispute vote period elapsed             → finalizeDispute (Tier 3)
          4. Global deadline exceeded                → refundAndSlash
        """
        while True:
            try:
                head = self.w3.eth.block_number
                if head > self.last_scanned_block:
                    batch_end = min(self.last_scanned_block + 10, head)

                    for ev in self.contract.events.IntentSolved.get_logs(
                        from_block=self.last_scanned_block + 1, to_block=batch_end
                    ):
                        iid  = ev["args"]["intentId"]
                        if self.active_intents.get(iid) == "Pending":
                            self.process_settlement(
                                iid, ev["args"]["dataUrl"], ev["args"]["resultHash"]
                            )

                    self.last_scanned_block = batch_end

                now = int(time.time())
                for iid, status in list(self.active_intents.items()):
                    if status in ("Settled", "Refunded"):
                        continue
                    try:
                        c  = self.contract.functions.intents(iid).call()
                        dp = self.contract.functions.intentDisputes(iid).call()

                        is_resolved   = c[6]
                        deadline      = c[8]
                        challenge_end = dp[0]
                        is_disputed   = dp[1]
                        vote_deadline = dp[4]

                        if is_resolved:
                            self.active_intents[iid] = "Settled"
                            continue

                        if status == "Pending" and c[5] and not is_disputed and challenge_end > 0 and now > challenge_end:
                            self._try_auto_settle(iid)
                        elif status == "Disputed" and vote_deadline > 0 and now > vote_deadline:
                            self._try_finalize_dispute(iid)
                        elif now > deadline:
                            self._refund_expired(iid)
                    except Exception as e:
                        print(f"[!] State query error: {e}")

            except Exception as e:
                print(f"[!] Event loop error (auto-retrying): {e}")
            time.sleep(2)

    # ── Task dispatch from file ──────────────────────────────────────

    def trigger_task_from_file(self, file_path: str = "task_payload.json"):
        """Read a JSON task payload from disk and publish it as an intent."""
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            self.dispatch_intent(task_payload=payload, min_score=85, bounty_eth=0.001)
        except FileNotFoundError:
            print(f"[!] File not found: {file_path}")
        except json.JSONDecodeError:
            print(f"[!] Invalid JSON in {file_path}")
        except Exception as e:
            print(f"[!] Error reading task file: {e}")

    # ── Main loop ────────────────────────────────────────────────────

    def run(self):
        watcher = threading.Thread(target=self.watch_events, daemon=True)
        watcher.start()
        print("[*] Event watcher started. Listening for settlement events...\n")

        try:
            while True:
                cmd = input("[Ready] Enter task file name (e.g. task_payload.json), or Ctrl+C to quit: ")
                if cmd.strip():
                    self.trigger_task_from_file(cmd.strip())
                else:
                    time.sleep(1)
        except KeyboardInterrupt:
            print("\n[*] Shutting down gracefully.")


if __name__ == "__main__":
    EmployerAgent().run()
