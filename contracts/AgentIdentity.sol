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
 */
contract AgentIdentity is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    mapping(uint256 => uint256) public agentScores;
    mapping(address => uint256) public addressToTokenId;

    constructor() ERC721("AgentIdentity", "AGID") Ownable(msg.sender) {}

    /// @notice Register a new on-chain agent identity.
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
    function updateScore(uint256 tokenId, uint256 newScore) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        agentScores[tokenId] = newScore;
    }

    /// @notice Read-only interface consumed by IntentPool.
    function getScore(address agent) external view returns (uint256) {
        uint256 tokenId = addressToTokenId[agent];
        require(tokenId != 0, "Agent not registered");
        return agentScores[tokenId];
    }
}
