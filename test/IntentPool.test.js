const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("AgentIdentity", function () {
  async function deployIdentityFixture() {
    const [owner, agent1, agent2] = await ethers.getSigners();
    const AgentIdentity = await ethers.getContractFactory("AgentIdentity");
    const identity = await AgentIdentity.deploy();
    return { identity, owner, agent1, agent2 };
  }

  describe("Registration", function () {
    it("should register a new agent with default score 50", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      expect(await identity.getScore(agent1.address)).to.equal(50);
    });

    it("should reject duplicate registration", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      await expect(
        identity.connect(agent1).registerAgent("ipfs://metadata2")
      ).to.be.revertedWith("Address already registered");
    });

    it("should mint an ERC-721 token to the agent", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      expect(await identity.balanceOf(agent1.address)).to.equal(1);
    });

    it("should store the correct tokenURI", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      const tokenId = await identity.addressToTokenId(agent1.address);
      expect(await identity.tokenURI(tokenId)).to.equal("ipfs://metadata1");
    });
  });

  describe("Score Management", function () {
    it("should allow owner to update an agent score", async function () {
      const { identity, owner, agent1 } = await loadFixture(
        deployIdentityFixture
      );
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      const tokenId = await identity.addressToTokenId(agent1.address);
      await identity.connect(owner).updateScore(tokenId, 90);
      expect(await identity.getScore(agent1.address)).to.equal(90);
    });

    it("should reject score update from non-owner", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await identity.connect(agent1).registerAgent("ipfs://metadata1");
      const tokenId = await identity.addressToTokenId(agent1.address);
      await expect(
        identity.connect(agent1).updateScore(tokenId, 90)
      ).to.be.revertedWithCustomError(identity, "OwnableUnauthorizedAccount");
    });

    it("should revert getScore for unregistered agent", async function () {
      const { identity, agent1 } = await loadFixture(deployIdentityFixture);
      await expect(identity.getScore(agent1.address)).to.be.revertedWith(
        "Agent not registered"
      );
    });
  });
});

describe("IntentPool", function () {
  const CHALLENGE_PERIOD = 3600; // 1 hour
  const VOTE_PERIOD = 7200; // 2 hours
  const ONE_DAY = 86400;
  const BOUNTY = ethers.parseEther("1.0");

  async function deployFullFixture() {
    const [owner, employer, worker, verifier1, verifier2, verifier3, outsider] =
      await ethers.getSigners();

    const AgentIdentity = await ethers.getContractFactory("AgentIdentity");
    const identity = await AgentIdentity.deploy();

    const IntentPool = await ethers.getContractFactory("IntentPool");
    const pool = await IntentPool.deploy(await identity.getAddress());

    // Register agents and set scores
    await identity.connect(worker).registerAgent("ipfs://worker");
    await identity.connect(verifier1).registerAgent("ipfs://v1");
    await identity.connect(verifier2).registerAgent("ipfs://v2");
    await identity.connect(verifier3).registerAgent("ipfs://v3");

    const workerTokenId = await identity.addressToTokenId(worker.address);
    const v1TokenId = await identity.addressToTokenId(verifier1.address);
    const v2TokenId = await identity.addressToTokenId(verifier2.address);
    const v3TokenId = await identity.addressToTokenId(verifier3.address);

    await identity.updateScore(workerTokenId, 90);
    await identity.updateScore(v1TokenId, 80);
    await identity.updateScore(v2TokenId, 75);
    await identity.updateScore(v3TokenId, 65);

    const intentId = ethers.keccak256(ethers.toUtf8Bytes("test-intent-1"));

    return {
      pool,
      identity,
      owner,
      employer,
      worker,
      verifier1,
      verifier2,
      verifier3,
      outsider,
      intentId,
    };
  }

  async function publishedFixture() {
    const fixture = await deployFullFixture();
    const { pool, employer, intentId } = fixture;

    await pool
      .connect(employer)
      .publishIntent(intentId, '{"task":"audit"}', 50, { value: BOUNTY });

    return fixture;
  }

  async function solvedFixture() {
    const fixture = await publishedFixture();
    const { pool, worker, intentId } = fixture;

    await pool
      .connect(worker)
      .submitResult(intentId, "0xabc123hash", "ipfs://result", {
        value: BOUNTY,
      });

    return fixture;
  }

  async function disputedFixture() {
    const fixture = await solvedFixture();
    const { pool, employer, intentId } = fixture;

    await pool.connect(employer).raiseDispute(intentId);

    return fixture;
  }

  // ─── Constructor ──────────────────────────────────────────────────

  describe("Constructor", function () {
    it("should reject zero address for identity contract", async function () {
      const IntentPool = await ethers.getContractFactory("IntentPool");
      await expect(
        IntentPool.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid identity contract address");
    });

    it("should store the identity contract reference", async function () {
      const { pool, identity } = await loadFixture(deployFullFixture);
      expect(await pool.identityContract()).to.equal(
        await identity.getAddress()
      );
    });
  });

  // ─── publishIntent ────────────────────────────────────────────────

  describe("publishIntent", function () {
    it("should publish an intent with correct fields", async function () {
      const { pool, employer, intentId } = await loadFixture(
        deployFullFixture
      );

      await pool
        .connect(employer)
        .publishIntent(intentId, '{"task":"audit"}', 50, { value: BOUNTY });

      const core = await pool.intents(intentId);
      expect(core.employer).to.equal(employer.address);
      expect(core.bounty).to.equal(BOUNTY);
      expect(core.minScore).to.equal(50);
      expect(core.isSolved).to.be.false;
      expect(core.isResolved).to.be.false;
    });

    it("should emit IntentPublished event", async function () {
      const { pool, employer, intentId } = await loadFixture(
        deployFullFixture
      );

      await expect(
        pool
          .connect(employer)
          .publishIntent(intentId, '{"task":"audit"}', 50, { value: BOUNTY })
      )
        .to.emit(pool, "IntentPublished")
        .withArgs(intentId, employer.address, BOUNTY, 50, '{"task":"audit"}');
    });

    it("should reject duplicate intent ID", async function () {
      const { pool, employer, intentId } = await loadFixture(
        publishedFixture
      );

      await expect(
        pool
          .connect(employer)
          .publishIntent(intentId, '{"task":"other"}', 50, { value: BOUNTY })
      ).to.be.revertedWith("Intent already exists");
    });

    it("should reject zero bounty", async function () {
      const { pool, employer, intentId } = await loadFixture(
        deployFullFixture
      );

      await expect(
        pool.connect(employer).publishIntent(intentId, '{"task":"audit"}', 50)
      ).to.be.revertedWith("Bounty must be greater than 0");
    });
  });

  // ─── submitResult ─────────────────────────────────────────────────

  describe("submitResult", function () {
    it("should accept a valid submission with matching stake", async function () {
      const { pool, worker, intentId } = await loadFixture(publishedFixture);

      await pool
        .connect(worker)
        .submitResult(intentId, "0xhash", "ipfs://data", { value: BOUNTY });

      const core = await pool.intents(intentId);
      expect(core.worker).to.equal(worker.address);
      expect(core.stake).to.equal(BOUNTY);
      expect(core.isSolved).to.be.true;
    });

    it("should emit IntentSolved event", async function () {
      const { pool, worker, intentId } = await loadFixture(publishedFixture);

      await expect(
        pool
          .connect(worker)
          .submitResult(intentId, "0xhash", "ipfs://data", { value: BOUNTY })
      )
        .to.emit(pool, "IntentSolved")
        .withArgs(intentId, worker.address, "0xhash", "ipfs://data");
    });

    it("should set the challenge period end", async function () {
      const { pool, worker, intentId } = await loadFixture(publishedFixture);

      await pool
        .connect(worker)
        .submitResult(intentId, "0xhash", "ipfs://data", { value: BOUNTY });

      const dispute = await pool.intentDisputes(intentId);
      expect(dispute.challengePeriodEnd).to.be.gt(0);
    });

    it("should reject submission for non-existent intent", async function () {
      const { pool, worker } = await loadFixture(publishedFixture);
      const fakeId = ethers.keccak256(ethers.toUtf8Bytes("fake"));

      await expect(
        pool
          .connect(worker)
          .submitResult(fakeId, "0xhash", "ipfs://data", { value: BOUNTY })
      ).to.be.revertedWith("Intent does not exist");
    });

    it("should reject duplicate submission", async function () {
      const { pool, worker, intentId } = await loadFixture(solvedFixture);

      await expect(
        pool
          .connect(worker)
          .submitResult(intentId, "0xhash2", "ipfs://data2", { value: BOUNTY })
      ).to.be.revertedWith("Intent already solved");
    });

    it("should reject insufficient stake", async function () {
      const { pool, worker, intentId } = await loadFixture(publishedFixture);
      const lowStake = ethers.parseEther("0.5");

      await expect(
        pool
          .connect(worker)
          .submitResult(intentId, "0xhash", "ipfs://data", {
            value: lowStake,
          })
      ).to.be.revertedWith("Must stake amount equal to bounty");
    });

    it("should reject worker with score below minScore", async function () {
      const { pool, identity, outsider, intentId } = await loadFixture(
        publishedFixture
      );

      await identity.connect(outsider).registerAgent("ipfs://outsider");
      // Default score is 50, which meets minScore of 50.
      // Set it lower to trigger rejection.
      const tokenId = await identity.addressToTokenId(outsider.address);
      const owner = (await ethers.getSigners())[0];
      await identity.connect(owner).updateScore(tokenId, 10);

      await expect(
        pool
          .connect(outsider)
          .submitResult(intentId, "0xhash", "ipfs://data", { value: BOUNTY })
      ).to.be.revertedWith("ERC-8004 score below requirement");
    });

    it("should reject submission after deadline", async function () {
      const { pool, worker, intentId } = await loadFixture(publishedFixture);

      await time.increase(ONE_DAY + 1);

      await expect(
        pool
          .connect(worker)
          .submitResult(intentId, "0xhash", "ipfs://data", { value: BOUNTY })
      ).to.be.revertedWith("Intent deadline passed");
    });
  });

  // ─── Tier 1: approveAndPay ────────────────────────────────────────

  describe("Tier 1: approveAndPay", function () {
    it("should transfer bounty + stake to worker", async function () {
      const { pool, employer, worker, intentId } = await loadFixture(
        solvedFixture
      );

      const balanceBefore = await ethers.provider.getBalance(worker.address);
      await pool.connect(employer).approveAndPay(intentId);
      const balanceAfter = await ethers.provider.getBalance(worker.address);

      expect(balanceAfter - balanceBefore).to.equal(BOUNTY * 2n);
    });

    it("should mark intent as resolved", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await pool.connect(employer).approveAndPay(intentId);
      const core = await pool.intents(intentId);
      expect(core.isResolved).to.be.true;
    });

    it("should emit IntentSettled event", async function () {
      const { pool, employer, worker, intentId } = await loadFixture(
        solvedFixture
      );

      await expect(pool.connect(employer).approveAndPay(intentId))
        .to.emit(pool, "IntentSettled")
        .withArgs(intentId, worker.address, BOUNTY * 2n);
    });

    it("should reject approval from non-employer", async function () {
      const { pool, outsider, intentId } = await loadFixture(solvedFixture);

      await expect(
        pool.connect(outsider).approveAndPay(intentId)
      ).to.be.revertedWith("Only employer can approve");
    });

    it("should reject approval on unsolved intent", async function () {
      const { pool, employer, intentId } = await loadFixture(publishedFixture);

      await expect(
        pool.connect(employer).approveAndPay(intentId)
      ).to.be.revertedWith("Intent not solved yet");
    });

    it("should reject double settlement", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await pool.connect(employer).approveAndPay(intentId);
      await expect(
        pool.connect(employer).approveAndPay(intentId)
      ).to.be.revertedWith("Intent already resolved");
    });
  });

  // ─── Tier 2: autoSettle ───────────────────────────────────────────

  describe("Tier 2: autoSettle", function () {
    it("should settle after challenge period with no dispute", async function () {
      const { pool, worker, outsider, intentId } = await loadFixture(
        solvedFixture
      );

      await time.increase(CHALLENGE_PERIOD + 1);

      const balanceBefore = await ethers.provider.getBalance(worker.address);
      await pool.connect(outsider).autoSettle(intentId);
      const balanceAfter = await ethers.provider.getBalance(worker.address);

      expect(balanceAfter - balanceBefore).to.equal(BOUNTY * 2n);
    });

    it("should reject autoSettle during challenge period", async function () {
      const { pool, outsider, intentId } = await loadFixture(solvedFixture);

      await expect(
        pool.connect(outsider).autoSettle(intentId)
      ).to.be.revertedWith("Challenge period still active");
    });

    it("should reject autoSettle when dispute is active", async function () {
      const { pool, outsider, intentId } = await loadFixture(disputedFixture);

      await time.increase(CHALLENGE_PERIOD + 1);

      await expect(
        pool.connect(outsider).autoSettle(intentId)
      ).to.be.revertedWith("Dispute in progress");
    });

    it("can be called by anyone (permissionless)", async function () {
      const { pool, outsider, intentId } = await loadFixture(solvedFixture);

      await time.increase(CHALLENGE_PERIOD + 1);

      await expect(pool.connect(outsider).autoSettle(intentId)).to.not.be
        .reverted;
    });
  });

  // ─── Tier 3: Dispute Resolution ───────────────────────────────────

  describe("Tier 3: raiseDispute", function () {
    it("should open a dispute within the challenge window", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await expect(pool.connect(employer).raiseDispute(intentId))
        .to.emit(pool, "ResultChallenged")
        .withArgs(intentId, employer.address);

      const dispute = await pool.intentDisputes(intentId);
      expect(dispute.isDisputed).to.be.true;
      expect(dispute.voteDeadline).to.be.gt(0);
    });

    it("should reject dispute from non-employer", async function () {
      const { pool, outsider, intentId } = await loadFixture(solvedFixture);

      await expect(
        pool.connect(outsider).raiseDispute(intentId)
      ).to.be.revertedWith("Only employer can raise dispute");
    });

    it("should reject dispute after challenge period", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await time.increase(CHALLENGE_PERIOD + 1);

      await expect(
        pool.connect(employer).raiseDispute(intentId)
      ).to.be.revertedWith("Challenge period expired");
    });

    it("should reject duplicate dispute", async function () {
      const { pool, employer, intentId } = await loadFixture(disputedFixture);

      await expect(
        pool.connect(employer).raiseDispute(intentId)
      ).to.be.revertedWith("Dispute already raised");
    });
  });

  describe("Tier 3: verifyResult", function () {
    it("should accept a valid verifier vote", async function () {
      const { pool, verifier1, intentId } = await loadFixture(
        disputedFixture
      );

      await expect(pool.connect(verifier1).verifyResult(intentId, true))
        .to.emit(pool, "VerifierVoted")
        .withArgs(intentId, verifier1.address, true, 80);
    });

    it("should track approve and reject votes separately", async function () {
      const { pool, verifier1, verifier2, intentId } = await loadFixture(
        disputedFixture
      );

      await pool.connect(verifier1).verifyResult(intentId, true);
      await pool.connect(verifier2).verifyResult(intentId, false);

      const dispute = await pool.intentDisputes(intentId);
      expect(dispute.approveVotes).to.equal(1);
      expect(dispute.rejectVotes).to.equal(1);
    });

    it("should reject double voting", async function () {
      const { pool, verifier1, intentId } = await loadFixture(
        disputedFixture
      );

      await pool.connect(verifier1).verifyResult(intentId, true);
      await expect(
        pool.connect(verifier1).verifyResult(intentId, false)
      ).to.be.revertedWith("Already voted");
    });

    it("should bar employer from voting", async function () {
      const { pool, employer, intentId } = await loadFixture(disputedFixture);

      await expect(
        pool.connect(employer).verifyResult(intentId, true)
      ).to.be.revertedWith("Conflict of interest: parties cannot vote");
    });

    it("should bar worker from voting", async function () {
      const { pool, worker, intentId } = await loadFixture(disputedFixture);

      await expect(
        pool.connect(worker).verifyResult(intentId, true)
      ).to.be.revertedWith("Conflict of interest: parties cannot vote");
    });

    it("should reject low-score verifier", async function () {
      const { pool, identity, outsider, intentId } = await loadFixture(
        disputedFixture
      );

      await identity.connect(outsider).registerAgent("ipfs://outsider");

      await expect(
        pool.connect(outsider).verifyResult(intentId, true)
      ).to.be.revertedWith("Verifier score too low");
    });

    it("should reject vote after voting period", async function () {
      const { pool, verifier1, intentId } = await loadFixture(
        disputedFixture
      );

      await time.increase(VOTE_PERIOD + 1);

      await expect(
        pool.connect(verifier1).verifyResult(intentId, true)
      ).to.be.revertedWith("Voting period expired");
    });
  });

  describe("Tier 3: finalizeDispute", function () {
    it("should finalize in favor of worker when approves >= rejects (optimistic bias)", async function () {
      const { pool, worker, verifier1, verifier2, verifier3, intentId } =
        await loadFixture(disputedFixture);

      await pool.connect(verifier1).verifyResult(intentId, true);
      await pool.connect(verifier2).verifyResult(intentId, true);
      await pool.connect(verifier3).verifyResult(intentId, false);

      const balanceBefore = await ethers.provider.getBalance(worker.address);
      await pool.finalizeDispute(intentId);
      const balanceAfter = await ethers.provider.getBalance(worker.address);

      expect(balanceAfter - balanceBefore).to.equal(BOUNTY * 2n);
    });

    it("should finalize in favor of employer when rejects > approves", async function () {
      const { pool, employer, verifier1, verifier2, verifier3, intentId } =
        await loadFixture(disputedFixture);

      await pool.connect(verifier1).verifyResult(intentId, false);
      await pool.connect(verifier2).verifyResult(intentId, false);
      await pool.connect(verifier3).verifyResult(intentId, true);

      const balanceBefore = await ethers.provider.getBalance(employer.address);
      await pool.finalizeDispute(intentId);
      const balanceAfter = await ethers.provider.getBalance(employer.address);

      expect(balanceAfter - balanceBefore).to.equal(BOUNTY * 2n);
    });

    it("should emit DisputeResolved event", async function () {
      const { pool, verifier1, verifier2, verifier3, intentId } =
        await loadFixture(disputedFixture);

      await pool.connect(verifier1).verifyResult(intentId, true);
      await pool.connect(verifier2).verifyResult(intentId, true);
      await pool.connect(verifier3).verifyResult(intentId, false);

      await expect(pool.finalizeDispute(intentId))
        .to.emit(pool, "DisputeResolved")
        .withArgs(intentId, true, 2, 1);
    });

    it("should allow early finalization when quorum is reached", async function () {
      const { pool, verifier1, verifier2, verifier3, intentId } =
        await loadFixture(disputedFixture);

      await pool.connect(verifier1).verifyResult(intentId, true);
      await pool.connect(verifier2).verifyResult(intentId, true);
      await pool.connect(verifier3).verifyResult(intentId, true);

      await expect(pool.finalizeDispute(intentId)).to.not.be.reverted;
    });

    it("should allow finalization after vote deadline even without quorum", async function () {
      const { pool, verifier1, intentId } = await loadFixture(
        disputedFixture
      );

      await pool.connect(verifier1).verifyResult(intentId, true);
      await time.increase(VOTE_PERIOD + 1);

      await expect(pool.finalizeDispute(intentId)).to.not.be.reverted;
    });

    it("should reject finalization before quorum and deadline", async function () {
      const { pool, verifier1, intentId } = await loadFixture(
        disputedFixture
      );

      await pool.connect(verifier1).verifyResult(intentId, true);

      await expect(pool.finalizeDispute(intentId)).to.be.revertedWith(
        "Voting still in progress"
      );
    });

    it("ties favor the worker (optimistic default)", async function () {
      const { pool, worker, verifier1, verifier2, verifier3, intentId } =
        await loadFixture(disputedFixture);

      await pool.connect(verifier1).verifyResult(intentId, true);
      await pool.connect(verifier2).verifyResult(intentId, false);
      // 1 approve, 1 reject — need to reach quorum or wait
      // Wait for vote deadline
      await time.increase(VOTE_PERIOD + 1);

      const balanceBefore = await ethers.provider.getBalance(worker.address);
      await pool.finalizeDispute(intentId);
      const balanceAfter = await ethers.provider.getBalance(worker.address);

      // Tie (1:1) should favor worker
      expect(balanceAfter - balanceBefore).to.equal(BOUNTY * 2n);
    });
  });

  // ─── Timeout Fallback ─────────────────────────────────────────────

  describe("refundAndSlash", function () {
    it("should refund bounty to employer when no submission before deadline", async function () {
      const { pool, employer, intentId } = await loadFixture(publishedFixture);

      await time.increase(ONE_DAY + 1);

      const balanceBefore = await ethers.provider.getBalance(employer.address);
      const tx = await pool.connect(employer).refundAndSlash(intentId);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(employer.address);

      expect(balanceAfter - balanceBefore + gasCost).to.equal(BOUNTY);
    });

    it("should refund bounty + slash worker stake when submitted but timed out", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await time.increase(ONE_DAY + 1);

      const balanceBefore = await ethers.provider.getBalance(employer.address);
      const tx = await pool.connect(employer).refundAndSlash(intentId);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(employer.address);

      expect(balanceAfter - balanceBefore + gasCost).to.equal(BOUNTY * 2n);
    });

    it("should reject refund from non-employer", async function () {
      const { pool, outsider, intentId } = await loadFixture(publishedFixture);

      await time.increase(ONE_DAY + 1);

      await expect(
        pool.connect(outsider).refundAndSlash(intentId)
      ).to.be.revertedWith("Only employer can refund");
    });

    it("should reject refund before deadline", async function () {
      const { pool, employer, intentId } = await loadFixture(publishedFixture);

      await expect(
        pool.connect(employer).refundAndSlash(intentId)
      ).to.be.revertedWith("Timeout not reached");
    });

    it("should reject refund on already resolved intent", async function () {
      const { pool, employer, intentId } = await loadFixture(solvedFixture);

      await pool.connect(employer).approveAndPay(intentId);
      await time.increase(ONE_DAY + 1);

      await expect(
        pool.connect(employer).refundAndSlash(intentId)
      ).to.be.revertedWith("Intent already resolved");
    });
  });
});
