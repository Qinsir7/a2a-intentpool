# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Monad Testnet (current) | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in the A2A IntentPool Protocol, please report it responsibly.

**DO NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **qinsir.eth@outlook.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation plan within 7 days.

## Scope

The following components are in scope for security reports:

| Component | In Scope |
|-----------|----------|
| `IntentPool.sol` | Yes |
| `AgentIdentity.sol` | Yes |
| `employer_sdk/` | Yes |
| `worker_cli/` | Yes |
| `web/` (Explorer frontend) | Yes |

## Known Considerations

- **AgentIdentity score updates** are currently owner-gated. This is a known centralization point that will be decentralized in future versions via a verifier consensus mechanism.
- **Private key storage**: The Employer daemon uses `.env` with 600 permissions; the Worker CLI uses Keystore V3 (scrypt KDF). Neither approach is hardware-wallet-grade — use dedicated testnet wallets only.
- **x.402 gateway**: The Worker's key delivery endpoint should be deployed behind TLS (e.g., via ngrok or a reverse proxy) in any non-local setup.

## Security Design

See the [Security Model](README.md#security-model) section of the README for the protocol's threat model and mitigations.
