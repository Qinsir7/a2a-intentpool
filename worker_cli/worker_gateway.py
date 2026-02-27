"""
x.402 Key Delivery Gateway — issues AES-256 decryption keys to
verified employers via the HTTP 402 challenge-response protocol.
"""

import hashlib

import requests as http_requests
from eth_account.messages import encode_defunct
from flask import Flask, jsonify, request
from flask_cors import CORS
from web3 import Web3

app = Flask(__name__)
CORS(app, expose_headers=["WWW-Authenticate"])

# ── Configuration ────────────────────────────────────────────────────

RPC_URL          = "https://testnet-rpc.monad.xyz"
CONTRACT_ADDRESS = "0x1a8d74e1ADf1Be715e20d39ccF7637b8486b5899"

CONTRACT_ABI = [
    {"inputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
     "name": "intents",
     "outputs": [
         {"internalType": "address", "name": "employer",   "type": "address"},
         {"internalType": "address", "name": "worker",     "type": "address"},
         {"internalType": "uint256", "name": "bounty",     "type": "uint256"},
         {"internalType": "uint256", "name": "stake",      "type": "uint256"},
         {"internalType": "uint256", "name": "minScore",   "type": "uint256"},
         {"internalType": "bool",    "name": "isSolved",   "type": "bool"},
         {"internalType": "bool",    "name": "isResolved", "type": "bool"},
         {"internalType": "uint256", "name": "createdAt",  "type": "uint256"},
         {"internalType": "uint256", "name": "deadline",   "type": "uint256"},
     ],
     "stateMutability": "view", "type": "function"}
]

_session = http_requests.Session()
_session.trust_env = False
w3       = Web3(Web3.HTTPProvider(RPC_URL, session=_session))
contract = w3.eth.contract(address=CONTRACT_ADDRESS, abi=CONTRACT_ABI)

_WORKER_PRIVATE_KEY: str = ""


# ── Crypto ───────────────────────────────────────────────────────────

def derive_aes_key(private_key_hex: str, intent_id: bytes) -> bytes:
    """Deterministic AES-256 key: SHA-256(worker_privkey || intentId)."""
    return hashlib.sha256(bytes.fromhex(private_key_hex) + intent_id).digest()


# ── x.402 Endpoint ───────────────────────────────────────────────────

@app.route("/key/<intent_id_hex>", methods=["GET"])
def deliver_key(intent_id_hex: str):
    """
    x.402 key delivery endpoint.

    1st request (no credentials):
      ← 402 Payment Required + WWW-Authenticate header

    2nd request (with employer signature):
      Authorization: x402 <signature_hex>
      ← 200 {"key": "<aes_key_hex>"}
    """
    print(f"\n[x.402] Key request for intent {intent_id_hex[:8]}...")

    auth = request.headers.get("Authorization")

    if not auth or not auth.startswith("x402 "):
        print("[x.402] No credentials — issuing 402 challenge")
        resp = jsonify({"error": "Payment Required"})
        resp.status_code = 402
        resp.headers["WWW-Authenticate"] = f'x402 challenge="Unlock_Key_{intent_id_hex}"'
        return resp

    try:
        signature = auth.split(" ", 1)[1]
        intent_id = bytes.fromhex(intent_id_hex)

        on_chain    = contract.functions.intents(intent_id).call()
        employer    = on_chain[0]
        is_solved   = on_chain[5]

        if not is_solved:
            return jsonify({"error": "Intent not solved yet"}), 400

        msg       = encode_defunct(text=f"Unlock_Key_{intent_id_hex}")
        recovered = w3.eth.account.recover_message(msg, signature=signature)

        if recovered.lower() != employer.lower():
            print(f"[x.402] Signature mismatch: {recovered} != {employer}")
            return jsonify({"error": "Unauthorized: signature mismatch"}), 403

        if not _WORKER_PRIVATE_KEY:
            return jsonify({"error": "Gateway not initialized"}), 500

        aes_key = derive_aes_key(_WORKER_PRIVATE_KEY, intent_id)
        print(f"[x.402] Verified — delivering key to {employer[:10]}...")
        return jsonify({"key": aes_key.hex()}), 200

    except Exception as e:
        print(f"[x.402] Error: {e}")
        return jsonify({"error": str(e)}), 500


def start_gateway(port: int = 5000, private_key: str = ""):
    global _WORKER_PRIVATE_KEY
    _WORKER_PRIVATE_KEY = private_key
    print(f"[*] x.402 key gateway listening on port {port}")
    app.run(host="0.0.0.0", port=port, use_reloader=False)


if __name__ == "__main__":
    start_gateway()
