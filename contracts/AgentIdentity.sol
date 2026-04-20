// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentIdentity
 * @author A2A IntentPool Protocol
 * @notice EIP-8004 compliant on-chain identity registry for AI agents,
 *         featuring a dynamic reputation score used by IntentPool for
 *         stake calibration and dispute-verifier eligibility.
 *
 * @dev Each agent address may hold at most one identity token.
 *      Scores default to 50 on registration and are owner-gated for now;
 *      production deployments should delegate scoring to a decentralized oracle.
 */
contract AgentIdentity is ERC721URIStorage, Ownable {
    /// @notice Auto-incrementing counter for token IDs (starts at 1).
    uint256 private _nextTokenId;

    /// @notice Mapping from token ID to the agent's current reputation score.
    mapping(uint256 => uint256) public agentScores;
    /// @notice Mapping from wallet address to the agent's token ID (0 = unregistered).
    mapping(address => uint256) public addressToTokenId;

    /// @notice Deploy the AgentIdentity registry.
    /// @dev Sets the deployer as the initial owner via OpenZeppelin's Ownable.
    constructor() ERC721("AgentIdentity", "AGID") Ownable(msg.sender) {}

    /// @notice Register a new on-chain agent identity.
    /// @dev Mints an ERC-721 token and assigns a default score of 50.
    ///      Reverts if the caller already holds an identity token.
    /// @param agentURI Metadata URI (e.g. IPFS JSON) describing the agent.
    function registerAgent(string memory agentURI) external {
        require(addressToTokenId[msg.sender] == 0, "Address already registered");

        _nextTokenId++;
        uint256 tokenId = _nextTokenId;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, agentURI);

        agentScores[tokenId] = 50;
        addressToTokenId[msg.sender] = tokenId;
    }

    /// @notice Update an agent's reputation score.
    /// @dev Owner-gated; production deployments should delegate to a decentralized arbitrator.
    /// @param tokenId  Token ID of the agent identity to update.
    /// @param newScore New reputation score to assign.
    function updateScore(uint256 tokenId, uint256 newScore) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        agentScores[tokenId] = newScore;
    }

    /// @notice Read-only interface consumed by IntentPool to gate worker eligibility.
    /// @param agent Address of the agent to query.
    /// @return The agent's current reputation score.
    function getScore(address agent) external view returns (uint256) {
        uint256 tokenId = addressToTokenId[agent];
        require(tokenId != 0, "Agent not registered");
        return agentScores[tokenId];
    }
}
