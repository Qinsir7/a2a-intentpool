"""
Worker Agent Daemon — listens for on-chain intents, delegates execution to a
pluggable agent backend, encrypts results to IPFS, and submits proofs on-chain.

The execution engine is abstracted behind the ``BaseExecutor`` interface.
OpenClaw ships as the default implementation; third-party agents can subclass
``BaseExecutor`` and register via ``EXECUTOR_CLASS`` to plug into the protocol.
"""

import hashlib
import json
import os
import subprocess
import time
from abc import ABC, abstractmethod

import requests
from Crypto.Cipher import AES
from web3 import Web3

# ── Configuration ────────────────────────────────────────────────────

RPC_URL          = "https://testnet-rpc.monad.xyz"
CONTRACT_ADDRESS = "0x1a8d74e1ADf1Be715e20d39ccF7637b8486b5899"

CONTRACT_ABI = [
    {"anonymous": False, "inputs": [{"indexed": True, "internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"indexed": True, "internalType": "address", "name": "employer", "type": "address"}, {"indexed": False, "internalType": "uint256", "name": "bounty", "type": "uint256"}, {"indexed": False, "internalType": "uint256", "name": "minScore", "type": "uint256"}, {"indexed": False, "internalType": "string", "name": "rawJsonSchema", "type": "string"}], "name": "IntentPublished", "type": "event"},
    {"inputs": [{"internalType": "bytes32", "name": "intentId", "type": "bytes32"}, {"internalType": "string", "name": "resultHash", "type": "string"}, {"internalType": "string", "name": "dataUrl", "type": "string"}], "name": "submitResult", "outputs": [], "stateMutability": "payable", "type": "function"},
]

_session = requests.Session()
_session.trust_env = False
w3       = Web3(Web3.HTTPProvider(RPC_URL, session=_session))
contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)


# ── Crypto helpers ───────────────────────────────────────────────────

def derive_aes_key(private_key_hex: str, intent_id: bytes) -> bytes:
    """Deterministic AES-256 key: SHA-256(worker_privkey || intentId)."""
    return hashlib.sha256(bytes.fromhex(private_key_hex) + intent_id).digest()


def aes_encrypt(key: bytes, plaintext: bytes) -> bytes:
    """AES-256-GCM encrypt. Output: nonce(16) | tag(16) | ciphertext."""
    cipher = AES.new(key, AES.MODE_GCM)
    ct, tag = cipher.encrypt_and_digest(plaintext)
    return cipher.nonce + tag + ct


# ── IPFS upload ──────────────────────────────────────────────────────

def upload_to_ipfs(data: bytes, filename: str) -> str:
    """Pin bytes to IPFS via Pinata and return a public gateway URL."""
    jwt = os.environ.get("PINATA_JWT", "")
    if not jwt:
        raise ValueError("PINATA_JWT not configured. Run 'python cli.py start' to set up.")

    s = requests.Session()
    s.trust_env = False
    resp = s.post(
        "https://api.pinata.cloud/pinning/pinFileToIPFS",
        headers={"Authorization": f"Bearer {jwt}"},
        files={"file": (filename, data, "application/octet-stream")},
    )
    resp.raise_for_status()
    cid = resp.json()["IpfsHash"]
    return f"https://gateway.pinata.cloud/ipfs/{cid}"


# ══════════════════════════════════════════════════════════════════════
#  Executor Interface — pluggable agent backends
# ══════════════════════════════════════════════════════════════════════

class BaseExecutor(ABC):
    """
    Abstract interface for task execution engines.

    Any AI agent framework (OpenClaw, LangChain, AutoGPT, custom scripts, etc.)
    can integrate with the A2A IntentPool protocol by implementing this interface.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name of the executor, shown in logs."""
        ...

    @abstractmethod
    def execute(self, intent_json_str: str) -> tuple[str | None, str | None]:
        """
        Execute a task described by the raw JSON intent schema.

        Returns:
            (result_hash, full_output) — SHA-256 hex digest and the full
            plaintext output. Return (None, None) to skip this intent.
        """
        ...


class OpenClawExecutor(BaseExecutor):
    """
    Default executor — delegates to a locally installed OpenClaw agent.
    Requires the ``openclaw`` CLI to be available on PATH.
    """

    @property
    def name(self) -> str:
        return "OpenClaw"

    def execute(self, intent_json_str: str) -> tuple[str | None, str | None]:
        print(f"\n[{self.name}] Task detected — waking execution engine...")

        intent_data  = json.loads(intent_json_str)
        target_code  = intent_data.get("target_code", "")
        requirements = intent_data.get("requirements", "")

        prompt = (
            f"Please analyze the following Solidity code:\n{target_code}\n"
            f"Task requirements: {requirements}\n"
            "Output ONLY the final Markdown audit report. "
            "Do not use any external web search or fetch tools."
        )

        try:
            print(f"[{self.name}] Starting local compute engine...")
            print("-" * 40 + f" {self.name} Agent Logs " + "-" * 40)

            proc = subprocess.Popen(
                ["openclaw", "agent", "--local", "--agent", "main", "--message", prompt],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )

            full_log = ""
            for line in proc.stdout:
                print(line, end="")
                full_log += line

            proc.wait()
            print("-" * 101)

            if proc.returncode != 0:
                print(f"[{self.name}] Execution failed. Skipping this intent.")
                return None, None

            print(f"\n[{self.name}] Task complete. Hashing output...")
            result_hash = hashlib.sha256(full_log.encode()).hexdigest()
            print(f"[{self.name}] SHA-256 attestation: 0x{result_hash[:10]}...")
            return result_hash, full_log

        except FileNotFoundError:
            print(f"[!] '{self.name}' CLI not found on PATH. Is it installed?")
            return None, None
        except Exception as e:
            print(f"[!] Execution error: {e}")
            return None, None


# Active executor instance — swap this to use a different agent backend
EXECUTOR: BaseExecutor = OpenClawExecutor()


# ── On-chain submission ──────────────────────────────────────────────

def submit_to_chain(
    intent_id: bytes,
    result_hash: str,
    data_url: str,
    bounty_wei: int,
    private_key: str,
):
    """Submit result hash + stake to the IntentPool contract."""
    account = w3.eth.account.from_key(private_key)
    balance = w3.eth.get_balance(account.address)

    print(f"\n[Chain] Signer: {account.address}")
    print(f"[Chain] Balance: {w3.from_wei(balance, 'ether')} MON | Stake required: {w3.from_wei(bounty_wei, 'ether')} MON")

    if balance < bounty_wei:
        print("[Chain] Insufficient balance for stake — skipping intent. Please top up.")
        return

    print("[Chain] Building transaction...")
    tx = contract.functions.submitResult(
        intent_id, result_hash, data_url
    ).build_transaction({
        "from": account.address,
        "value": bounty_wei,
        "nonce": w3.eth.get_transaction_count(account.address),
        "gas": 300_000,
        "gasPrice": w3.eth.gas_price,
    })

    signed = w3.eth.account.sign_transaction(tx, private_key=private_key)
    print("[Chain] Broadcasting...")
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)

    print(f"[Chain] Submitted | tx: {tx_hash.hex()}")
    w3.eth.wait_for_transaction_receipt(tx_hash)
    print("[Chain] Confirmed. Awaiting employer settlement.")


# ── Main listener loop ───────────────────────────────────────────────

def listen_for_intents(private_key: str | None = None):
    if not private_key:
        raise ValueError("No private key provided. Start via 'python cli.py start'.")

    account = w3.eth.account.from_key(private_key)
    print(f"[Worker] Node online | executor: {EXECUTOR.name} | address: {account.address}")
    print(f"[Worker] Listening on contract {CONTRACT_ADDRESS} (polling)...\n")

    last_block = w3.eth.block_number

    while True:
        try:
            head = w3.eth.block_number
            if head > last_block:
                batch_end = min(last_block + 10, head)
                logs = contract.events.IntentPublished.get_logs(
                    from_block=last_block + 1, to_block=batch_end
                )
                last_block = batch_end

                for event in logs:
                    args      = event["args"]
                    iid       = args["intentId"]
                    employer  = args["employer"]
                    bounty    = args["bounty"]
                    min_score = args["minScore"]
                    raw_json  = args["rawJsonSchema"]

                    print("\n" + "=" * 50)
                    print("[MATCH] New intent detected!")
                    print(f"  Intent ID : {iid.hex()}")
                    print(f"  Employer  : {employer}")
                    print(f"  Bounty    : {w3.from_wei(bounty, 'ether')} MON")
                    print(f"  Min Score : {min_score}")
                    print("=" * 50)

                    try:
                        result_hash, full_log = EXECUTOR.execute(raw_json)
                        if not result_hash:
                            continue

                        aes_key = derive_aes_key(private_key, iid)
                        print("[AES]   Encrypting result with deterministic key...")
                        encrypted = aes_encrypt(aes_key, full_log.encode("utf-8"))

                        gateway_url = os.environ.get("GATEWAY_PUBLIC_URL", "http://127.0.0.1:5000")
                        manifest = json.dumps({
                            "version": "1.0",
                            "key_gateway": gateway_url + "/key",
                            "encrypted_data": encrypted.hex(),
                        }).encode("utf-8")

                        print("[IPFS]  Uploading encrypted manifest...")
                        ipfs_url = upload_to_ipfs(manifest, filename=f"{iid.hex()}.json")
                        print(f"[IPFS]  Pinned: {ipfs_url}")

                        submit_to_chain(iid, result_hash, ipfs_url, bounty, private_key)

                    except Exception as e:
                        print(f"[!] Intent {iid.hex()[:8]}... processing failed (skipped): {e}")

        except Exception as e:
            print(f"[!] RPC poll error (auto-retrying): {e}")

        time.sleep(1)


if __name__ == "__main__":
    listen_for_intents()
