// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAgentIdentity {
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
    IAgentIdentity public identityContract;

    uint256 public constant CHALLENGE_PERIOD   = 1 hours;
    uint256 public constant VOTE_PERIOD        = 2 hours;
    uint256 public constant MIN_VERIFIER_SCORE = 60;
    uint256 public constant MIN_VERIFIER_VOTES = 3;

    /// @notice Core intent fields (9 slots).
    struct IntentCore {
        address employer;
        address worker;
        uint256 bounty;
        uint256 stake;
        uint256 minScore;
        bool    isSolved;
        bool    isResolved;
        uint256 createdAt;
        uint256 deadline;
    }

    /// @notice Dispute-specific fields (5 slots).
    struct IntentDispute {
        uint256 challengePeriodEnd;
        bool    isDisputed;
        uint256 approveVotes;
        uint256 rejectVotes;
        uint256 voteDeadline;
    }

    mapping(bytes32 => IntentCore)    public intents;
    mapping(bytes32 => IntentDispute) public intentDisputes;
    mapping(bytes32 => mapping(address => bool)) public hasVerifierVoted;

    event IntentPublished (bytes32 indexed intentId, address indexed employer, uint256 bounty, uint256 minScore, string rawJsonSchema);
    event IntentSolved    (bytes32 indexed intentId, address indexed worker,   string resultHash, string dataUrl);
    event IntentSettled   (bytes32 indexed intentId, address indexed recipient, uint256 payout);
    event ResultChallenged(bytes32 indexed intentId, address indexed employer);
    event VerifierVoted   (bytes32 indexed intentId, address indexed verifier, bool approved, uint256 score);
    event DisputeResolved (bytes32 indexed intentId, bool workerWon, uint256 approveVotes, uint256 rejectVotes);

    constructor(address _identityContract) {
        require(_identityContract != address(0), "Invalid identity contract address");
        identityContract = IAgentIdentity(_identityContract);
    }

    // ─── Core ────────────────────────────────────────────────────────

    /// @notice Publish an intent with attached bounty.
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
