// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAgentIdentity
/// @notice Minimal interface for the ERC-8004 on-chain reputation registry.
interface IAgentIdentity {
    /// @notice Return the reputation score of an agent.
    /// @param agent Address of the agent to query.
    /// @return Reputation score (higher is better; scale defined by implementation).
    function getScore(address agent) external view returns (uint256);
}

/**
 * @title IntentPool
 * @author A2A IntentPool Protocol
 * @notice Trustless settlement layer for the Agent-to-Agent (A2A) machine economy.
 *
 *  Three-tier anti-hallucination protection:
 *
 *    Tier 1 — Fast Track (`approveAndPay`)
 *      Employer verifies result off-chain and settles immediately.
 *
 *    Tier 2 — Optimistic Settlement (`autoSettle`)
 *      After submission a CHALLENGE_PERIOD window opens.
 *      If no dispute is raised, anyone may call `autoSettle` to release funds.
 *
 *    Tier 3 — Cross-AI Verification (`raiseDispute` / `verifyResult` / `finalizeDispute`)
 *      Employer raises a dispute within the challenge window.
 *      Third-party AI agents with ERC-8004 reputation >= MIN_VERIFIER_SCORE vote.
 *      Majority decides; ties favor the Worker (optimistic default).
 *
 * @dev Intent state is split across two mappings (`intents` / `intentDisputes`)
 *      to stay under the EVM stack limit without requiring `viaIR`.
 */
contract IntentPool {
    /// @notice Reference to the ERC-8004 reputation registry.
    IAgentIdentity public identityContract;

    /// @notice Duration of the challenge window after a result is submitted.
    uint256 public constant CHALLENGE_PERIOD   = 1 hours;
    /// @notice Duration of the voting window after a dispute is raised.
    uint256 public constant VOTE_PERIOD        = 2 hours;
    /// @notice Minimum ERC-8004 score required for third-party verifiers.
    uint256 public constant MIN_VERIFIER_SCORE = 60;
    /// @notice Minimum number of verifier votes before early finalization is allowed.
    uint256 public constant MIN_VERIFIER_VOTES = 3;

    /// @notice Core intent fields (9 slots).
    struct IntentCore {
        /// @notice Address that published the intent and deposited the bounty.
        address employer;
        /// @notice Address that submitted a result (zero until solved).
        address worker;
        /// @notice Bounty deposited by the employer (in wei).
        uint256 bounty;
        /// @notice Stake deposited by the worker (must equal bounty).
        uint256 stake;
        /// @notice Minimum ERC-8004 reputation score required to accept this intent.
        uint256 minScore;
        /// @notice Whether a worker has submitted a result.
        bool    isSolved;
        /// @notice Whether the intent has been finally settled or refunded.
        bool    isResolved;
        /// @notice Block timestamp when the intent was published.
        uint256 createdAt;
        /// @notice Absolute deadline after which the employer may reclaim funds.
        uint256 deadline;
    }

    /// @notice Dispute-specific fields (5 slots).
    struct IntentDispute {
        /// @notice Timestamp when the challenge window closes.
        uint256 challengePeriodEnd;
        /// @notice Whether the employer has raised a dispute.
        bool    isDisputed;
        /// @notice Number of verifier votes in favor of the worker.
        uint256 approveVotes;
        /// @notice Number of verifier votes against the worker.
        uint256 rejectVotes;
        /// @notice Timestamp when the voting window closes.
        uint256 voteDeadline;
    }

    /// @notice Mapping from intent ID to its core state.
    mapping(bytes32 => IntentCore)    public intents;
    /// @notice Mapping from intent ID to its dispute state.
    mapping(bytes32 => IntentDispute) public intentDisputes;
    /// @notice Tracks whether a verifier has already voted on a given intent.
    mapping(bytes32 => mapping(address => bool)) public hasVerifierVoted;

    /// @notice Emitted when a new intent is published.
    /// @param intentId      Unique identifier for the intent.
    /// @param employer      Address of the intent publisher.
    /// @param bounty        Bounty amount in wei.
    /// @param minScore      Minimum ERC-8004 score required for workers.
    /// @param rawJsonSchema JSON schema describing the task requirements.
    event IntentPublished (bytes32 indexed intentId, address indexed employer, uint256 bounty, uint256 minScore, string rawJsonSchema);

    /// @notice Emitted when a worker submits a result.
    /// @param intentId   Unique identifier for the intent.
    /// @param worker     Address of the worker that solved the intent.
    /// @param resultHash SHA-256 hex digest of the plaintext result.
    /// @param dataUrl    URL (typically IPFS) of the encrypted result manifest.
    event IntentSolved    (bytes32 indexed intentId, address indexed worker,   string resultHash, string dataUrl);

    /// @notice Emitted when funds are released to the winner (worker or employer).
    /// @param intentId  Unique identifier for the intent.
    /// @param recipient Address that received the payout.
    /// @param payout    Total amount transferred (bounty + stake).
    event IntentSettled   (bytes32 indexed intentId, address indexed recipient, uint256 payout);

    /// @notice Emitted when the employer raises a dispute.
    /// @param intentId Unique identifier for the intent.
    /// @param employer Address of the employer that raised the dispute.
    event ResultChallenged(bytes32 indexed intentId, address indexed employer);

    /// @notice Emitted when a third-party verifier casts a vote.
    /// @param intentId Unique identifier for the intent.
    /// @param verifier Address of the verifier.
    /// @param approved Whether the verifier voted to approve the result.
    /// @param score    ERC-8004 reputation score of the verifier at vote time.
    event VerifierVoted   (bytes32 indexed intentId, address indexed verifier, bool approved, uint256 score);

    /// @notice Emitted when a dispute is resolved by majority vote.
    /// @param intentId     Unique identifier for the intent.
    /// @param workerWon    Whether the worker won the dispute (ties favor worker).
    /// @param approveVotes Total approve votes at finalization.
    /// @param rejectVotes  Total reject votes at finalization.
    event DisputeResolved (bytes32 indexed intentId, bool workerWon, uint256 approveVotes, uint256 rejectVotes);

    /// @notice Deploy the IntentPool contract.
    /// @param _identityContract Address of the deployed ERC-8004 AgentIdentity contract.
    constructor(address _identityContract) {
        require(_identityContract != address(0), "Invalid identity contract address");
        identityContract = IAgentIdentity(_identityContract);
    }

    // ─── Core ────────────────────────────────────────────────────────

    /// @notice Publish an intent with attached bounty.
    /// @param intentId     Unique 32-byte identifier chosen by the employer.
    /// @param rawJsonSchema JSON schema describing the task requirements (stored in event only).
    /// @param minScore     Minimum ERC-8004 reputation score a worker must hold.
    function publishIntent(
        bytes32 intentId,
        string calldata rawJsonSchema,
        uint256 minScore
    ) external payable {
        require(intents[intentId].employer == address(0), "Intent already exists");
        require(msg.value > 0, "Bounty must be greater than 0");

        intents[intentId] = IntentCore({
            employer:   msg.sender,
            worker:     address(0),
            bounty:     msg.value,
            stake:      0,
            minScore:   minScore,
            isSolved:   false,
            isResolved: false,
            createdAt:  block.timestamp,
            deadline:   block.timestamp + 1 days
        });

        emit IntentPublished(intentId, msg.sender, msg.value, minScore, rawJsonSchema);
    }

    /// @notice Worker submits a result hash with matching stake; opens the challenge window.
    /// @param intentId   Identifier of the intent being solved.
    /// @param resultHash SHA-256 hex digest of the plaintext result for on-chain attestation.
    /// @param dataUrl    URL of the encrypted result manifest (typically an IPFS gateway link).
    function submitResult(
        bytes32 intentId,
        string calldata resultHash,
        string calldata dataUrl
    ) external payable {
        IntentCore storage core = intents[intentId];
        require(core.employer != address(0), "Intent does not exist");
        require(!core.isSolved,   "Intent already solved");
        require(!core.isResolved, "Intent already resolved");
        require(block.timestamp <= core.deadline, "Intent deadline passed");
        require(msg.value >= core.bounty, "Must stake amount equal to bounty");

        uint256 workerScore = identityContract.getScore(msg.sender);
        require(workerScore >= core.minScore, "ERC-8004 score below requirement");

        core.worker   = msg.sender;
        core.stake    = msg.value;
        core.isSolved = true;

        intentDisputes[intentId].challengePeriodEnd = block.timestamp + CHALLENGE_PERIOD;

        emit IntentSolved(intentId, msg.sender, resultHash, dataUrl);
    }

    // ─── Tier 1: Fast Track ──────────────────────────────────────────

    /// @notice Employer directly approves and releases funds (fastest path).
    /// @param intentId Identifier of the intent to settle.
    function approveAndPay(bytes32 intentId) external {
        IntentCore storage core = intents[intentId];
        require(core.isSolved,    "Intent not solved yet");
        require(!core.isResolved, "Intent already resolved");
        require(!intentDisputes[intentId].isDisputed, "Dispute in progress, use finalizeDispute");
        require(msg.sender == core.employer, "Only employer can approve");

        core.isResolved = true;
        uint256 payout = core.bounty + core.stake;
        (bool ok,) = core.worker.call{value: payout}("");
        require(ok, "Transfer failed");

        emit IntentSettled(intentId, core.worker, payout);
    }

    // ─── Tier 2: Optimistic Settlement ───────────────────────────────

    /// @notice Auto-settle after challenge period expires with no dispute.
    /// @param intentId Identifier of the intent to settle.
    function autoSettle(bytes32 intentId) external {
        IntentCore    storage core    = intents[intentId];
        IntentDispute storage dispute = intentDisputes[intentId];

        require(core.isSolved,                           "Intent not solved yet");
        require(!core.isResolved,                        "Already resolved");
        require(!dispute.isDisputed,                     "Dispute in progress");
        require(dispute.challengePeriodEnd > 0,          "Challenge period not started");
        require(block.timestamp > dispute.challengePeriodEnd, "Challenge period still active");

        core.isResolved = true;
        uint256 payout = core.bounty + core.stake;
        (bool ok,) = core.worker.call{value: payout}("");
        require(ok, "Transfer failed");

        emit IntentSettled(intentId, core.worker, payout);
    }

    // ─── Tier 3: Cross-AI Dispute Resolution ─────────────────────────

    /// @notice Employer raises a dispute within the challenge window, triggering a vote.
    /// @param intentId Identifier of the intent to dispute.
    function raiseDispute(bytes32 intentId) external {
        IntentCore    storage core    = intents[intentId];
        IntentDispute storage dispute = intentDisputes[intentId];

        require(msg.sender == core.employer, "Only employer can raise dispute");
        require(core.isSolved,               "Intent not solved yet");
        require(!core.isResolved,            "Already resolved");
        require(!dispute.isDisputed,         "Dispute already raised");
        require(block.timestamp <= dispute.challengePeriodEnd, "Challenge period expired");

        dispute.isDisputed   = true;
        dispute.voteDeadline = block.timestamp + VOTE_PERIOD;

        emit ResultChallenged(intentId, msg.sender);
    }

    /// @notice Third-party AI agent casts a vote on a disputed result.
    /// @dev Conflict-of-interest: employer and worker are barred from voting.
    /// @param intentId Identifier of the disputed intent.
    /// @param approve  True to approve the worker's result, false to reject.
    function verifyResult(bytes32 intentId, bool approve) external {
        IntentCore    storage core    = intents[intentId];
        IntentDispute storage dispute = intentDisputes[intentId];

        require(dispute.isDisputed,   "No active dispute");
        require(!core.isResolved,     "Already resolved");
        require(block.timestamp <= dispute.voteDeadline, "Voting period expired");
        require(!hasVerifierVoted[intentId][msg.sender], "Already voted");
        require(
            msg.sender != core.employer && msg.sender != core.worker,
            "Conflict of interest: parties cannot vote"
        );

        uint256 score = identityContract.getScore(msg.sender);
        require(score >= MIN_VERIFIER_SCORE, "Verifier score too low");

        hasVerifierVoted[intentId][msg.sender] = true;
        if (approve) {
            dispute.approveVotes++;
        } else {
            dispute.rejectVotes++;
        }

        emit VerifierVoted(intentId, msg.sender, approve, score);
    }

    /// @notice Finalize a dispute after the vote period or quorum is reached.
    /// @dev Ties favor the Worker (optimistic bias toward execution).
    /// @param intentId Identifier of the disputed intent to finalize.
    function finalizeDispute(bytes32 intentId) external {
        IntentCore    storage core    = intents[intentId];
        IntentDispute storage dispute = intentDisputes[intentId];

        require(dispute.isDisputed, "No active dispute");
        require(!core.isResolved,   "Already resolved");
        require(
            block.timestamp > dispute.voteDeadline ||
            dispute.approveVotes + dispute.rejectVotes >= MIN_VERIFIER_VOTES,
            "Voting still in progress"
        );

        core.isResolved = true;
        bool workerWon = dispute.approveVotes >= dispute.rejectVotes;

        emit DisputeResolved(intentId, workerWon, dispute.approveVotes, dispute.rejectVotes);

        if (workerWon) {
            uint256 payout = core.bounty + core.stake;
            (bool ok,) = core.worker.call{value: payout}("");
            require(ok, "Worker payout failed");
            emit IntentSettled(intentId, core.worker, payout);
        } else {
            uint256 refund = core.bounty + core.stake;
            (bool ok,) = core.employer.call{value: refund}("");
            require(ok, "Employer refund failed");
            emit IntentSettled(intentId, core.employer, refund);
        }
    }

    // ─── Timeout Fallback ────────────────────────────────────────────

    /// @notice Employer reclaims bounty (+ worker stake if applicable) after deadline.
    /// @dev If the intent was solved but expired (e.g. dispute stalled), the worker's
    ///      stake is also transferred to the employer as a slashing penalty.
    /// @param intentId Identifier of the expired intent to refund.
    function refundAndSlash(bytes32 intentId) external {
        IntentCore storage core = intents[intentId];
        require(msg.sender == core.employer, "Only employer can refund");
        require(!core.isResolved, "Intent already resolved");
        require(block.timestamp > core.deadline, "Timeout not reached");

        core.isResolved = true;
        uint256 refund = core.bounty;
        if (core.isSolved) {
            refund += core.stake;
        }

        (bool ok,) = core.employer.call{value: refund}("");
        require(ok, "Refund transfer failed");

        emit IntentSettled(intentId, core.employer, refund);
    }
}
