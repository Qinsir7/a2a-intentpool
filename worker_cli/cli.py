"""
A2A IntentPool Worker CLI — unified entry point for node initialization,
keystore management, IPFS/gateway configuration, and daemon lifecycle.

Ships with OpenClaw as the default execution engine. Third-party agent
frameworks can integrate by subclassing ``BaseExecutor`` in worker.py.
"""

import argparse
import getpass
import json
import multiprocessing
import os
import sys
import time

from eth_account import Account

from worker import listen_for_intents
from worker_gateway import start_gateway

KEYSTORE_PATH = os.path.expanduser("~/.openclaw/keystore.json")
CONFIG_PATH   = os.path.expanduser("~/.openclaw/config.json")


def banner():
    print("""
    ================================================
      A2A IntentPool Worker Agent
      powered by OpenClaw
    ================================================
    """)


# ── Config persistence ───────────────────────────────────────────────

def load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
    return {}


def save_config(cfg: dict):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(CONFIG_PATH, 0o600)


# ── Pinata JWT setup ─────────────────────────────────────────────────

def ensure_pinata_jwt(cfg: dict) -> dict:
    """Prompt for Pinata JWT if not already configured."""
    if cfg.get("pinata_jwt"):
        return cfg

    print("\n[*] Pinata JWT not found. Starting IPFS upload setup...")
    print("[*] Go to https://app.pinata.cloud -> API Keys -> New Key")
    print("[*] Enable pinFileToIPFS, select JWT type, and copy.\n")
    jwt = input("[?] Paste your Pinata JWT: ").strip()
    if not jwt:
        print("[!] JWT cannot be empty.")
        sys.exit(1)

    cfg["pinata_jwt"] = jwt
    save_config(cfg)
    print(f"[+] Pinata JWT saved to {CONFIG_PATH} (permissions 600)\n")
    return cfg


# ── Gateway URL detection ────────────────────────────────────────────

def _try_get_ngrok_url(port: int) -> str:
    """Auto-detect a running ngrok tunnel via its local API."""
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=2) as r:
            data = json.loads(r.read())
        for tunnel in data.get("tunnels", []):
            if tunnel.get("proto") == "https":
                return tunnel["public_url"]
    except Exception:
        pass
    return ""


def ensure_gateway_url(cfg: dict, port: int = 5000) -> dict:
    """
    Resolve the public URL for the x.402 key gateway:
      1. Auto-detect a running ngrok tunnel
      2. Prompt for manual URL if ngrok is absent
      3. Fall back to localhost for single-machine demos
    """
    print("\n[*] Detecting public gateway address...")
    ngrok_url = _try_get_ngrok_url(port)
    if ngrok_url:
        cfg["gateway_public_url"] = ngrok_url
        save_config(cfg)
        print(f"[+] ngrok tunnel detected: {ngrok_url}")
        print(f"[+] x.402 key gateway will serve via this address\n")
        return cfg

    print("[*] No ngrok tunnel detected.")
    print("[*] Options:")
    print(f"  A) Start ngrok first (recommended):  ngrok http {port}")
    print("  B) Enter a public IP / domain manually")
    print("  C) Press Enter for localhost (single-machine demo only)\n")
    url = input("[?] Gateway public URL (Enter = localhost): ").strip()
    cfg["gateway_public_url"] = url or f"http://127.0.0.1:{port}"
    save_config(cfg)
    if not url:
        print("[!] Using localhost — remote employers will NOT be able to reach the gateway.")
    print(f"[+] Gateway URL saved: {cfg['gateway_public_url']}\n")
    return cfg


# ── Keystore management ─────────────────────────────────────────────

def run_init_flow():
    """First-run setup: prompt for private key and encrypt to Keystore V3."""
    print("[*] No keystore found. Starting first-run initialization...\n")

    raw_key = getpass.getpass("[?] Enter wallet private key (hidden): ").strip()
    raw_key = raw_key.removeprefix("0x")

    try:
        account = Account.from_key(raw_key)
    except Exception:
        print("[!] Invalid private key format.")
        sys.exit(1)

    while True:
        password = getpass.getpass("[?] Set keystore password (min 8 chars): ")
        if len(password) < 8:
            print("[!] Password too short. Minimum 8 characters.\n")
            continue
        confirm = getpass.getpass("[?] Confirm password: ")
        if password != confirm:
            print("[!] Passwords do not match. Try again.\n")
            continue
        break

    keystore_json = Account.encrypt(raw_key, password)
    os.makedirs(os.path.dirname(KEYSTORE_PATH), exist_ok=True)
    with open(KEYSTORE_PATH, "w") as f:
        json.dump(keystore_json, f, indent=2)
    os.chmod(KEYSTORE_PATH, 0o600)

    del raw_key, password, confirm

    print(f"\n[+] Keystore encrypted and saved to: {KEYSTORE_PATH}")
    print(f"[+] Node address: {account.address}")
    print(f"[+] File permissions: 600\n")


def unlock_keystore() -> str:
    """Decrypt the keystore file interactively; private key lives only in memory."""
    with open(KEYSTORE_PATH, "r") as f:
        ks = json.load(f)

    password = getpass.getpass("[?] Enter keystore password: ")
    try:
        pk_bytes = Account.decrypt(ks, password)
        del password
        return pk_bytes.hex()
    except Exception:
        print("[!] Wrong password. Keystore unlock failed.")
        sys.exit(1)


# ── Commands ─────────────────────────────────────────────────────────

def cmd_start(_args):
    banner()

    if not os.path.exists(KEYSTORE_PATH):
        run_init_flow()

    gateway_port = 5000
    cfg = load_config()
    cfg = ensure_pinata_jwt(cfg)
    cfg = ensure_gateway_url(cfg, port=gateway_port)

    os.environ["PINATA_JWT"]         = cfg["pinata_jwt"]
    os.environ["GATEWAY_PUBLIC_URL"] = cfg["gateway_public_url"]

    print("[*] Unlocking keystore...")
    private_key = unlock_keystore()

    account = Account.from_key(private_key)
    print(f"[+] Node address: {account.address}\n")

    gw = multiprocessing.Process(target=start_gateway, args=(gateway_port, private_key))
    gw.daemon = True
    gw.start()

    listener = multiprocessing.Process(target=listen_for_intents, args=(private_key,))
    listener.daemon = True
    listener.start()

    del private_key

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[*] Shutting down worker agent...")
        gw.terminate()
        listener.terminate()
        gw.join()
        listener.join()
        print("[*] Node stopped.")
        sys.exit(0)


def cmd_reset(args):
    """Reset keystore, Pinata JWT, or gateway config."""
    target = getattr(args, "target", "all") or "all"

    if target in ("keystore", "all") and os.path.exists(KEYSTORE_PATH):
        confirm = input(f"[!] Delete existing keystore ({KEYSTORE_PATH})? [y/N]: ")
        if confirm.lower() == "y":
            os.remove(KEYSTORE_PATH)
            print("[+] Keystore deleted.")
            run_init_flow()

    if target in ("jwt", "all") and os.path.exists(CONFIG_PATH):
        cfg = load_config()
        cfg.pop("pinata_jwt", None)
        save_config(cfg)
        print("[+] Pinata JWT cleared. Will prompt on next start.")

    if target in ("gateway", "all") and os.path.exists(CONFIG_PATH):
        cfg = load_config()
        cfg.pop("gateway_public_url", None)
        save_config(cfg)
        print("[+] Gateway URL cleared. Will prompt on next start.")


# ── Entry point ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="A2A IntentPool Worker CLI")
    subs = parser.add_subparsers(dest="command")

    subs.add_parser("start", help="Start the worker agent (auto-initializes on first run)")

    reset_p = subs.add_parser("reset", help="Reset configuration (keystore / jwt / gateway / all)")
    reset_p.add_argument(
        "target", nargs="?", default="all",
        choices=["keystore", "jwt", "gateway", "all"],
        help="What to reset (default: all)",
    )

    args = parser.parse_args()
    if args.command == "reset":
        cmd_reset(args)
    else:
        cmd_start(args)


if __name__ == "__main__":
    main()
