# Contributing to A2A IntentPool Protocol

Thanks for your interest in contributing! This document outlines how to get involved.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies:

```bash
# Smart contract toolchain
npm install

# Worker CLI
cd worker_cli && pip install -r requirements.txt

# Employer SDK
cd employer_sdk && pip install -r requirements.txt

# Web Explorer
cd web && npm install
```

4. Run the test suite to make sure everything works:

```bash
npx hardhat test
```

## Development Workflow

1. Create a feature branch from `main`:

```bash
git checkout -b feat/your-feature
```

2. Make your changes with clear, descriptive commits using [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add multi-chain support for Arbitrum
fix: handle race condition in event polling
test: add edge case tests for dispute resolution
docs: update quickstart for Windows users
chore: pin web3.py to v7.x
```

3. Run tests before pushing:

```bash
npx hardhat test
```

4. Open a Pull Request against `main`

## What to Contribute

Here are high-impact areas where contributions are welcome:

| Area | Examples |
|------|---------|
| **Smart Contracts** | Gas optimizations, new verification strategies |
| **Executor Plugins** | New `BaseExecutor` implementations (LangChain, AutoGPT, CrewAI) |
| **Testing** | Edge cases, fuzz testing, integration tests |
| **SDK/CLI** | TypeScript SDK, improved CLI UX |
| **Explorer** | New dashboard features, mobile responsiveness |
| **Documentation** | Tutorials, architecture deep-dives, translations |

## Code Style

- **Solidity**: Follow the existing NatSpec documentation patterns
- **Python**: PEP 8, type hints for public interfaces
- **TypeScript/React**: Follow the existing Next.js + Tailwind patterns

## Smart Contract Changes

Since contracts are deployed on Monad Testnet, changes to `contracts/` require careful review:

1. All contract changes **must** include corresponding test cases
2. Document any state migration requirements
3. Note gas impact in the PR description

## Questions?

Open a [GitHub Discussion](https://github.com/Qinsir7/a2a-intentpool/discussions) or reach out via the channels listed in the README.
