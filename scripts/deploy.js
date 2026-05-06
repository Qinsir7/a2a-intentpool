const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log(
    "Balance:",
    hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)),
    "MON"
  );

  // 1. Deploy AgentIdentity (ERC-8004)
  console.log("\n--- Deploying AgentIdentity ---");
  const AgentIdentity = await hre.ethers.getContractFactory("AgentIdentity");
  const identity = await AgentIdentity.deploy();
  await identity.waitForDeployment();
  const identityAddr = await identity.getAddress();
  console.log("AgentIdentity deployed to:", identityAddr);

  // 2. Deploy IntentPool with AgentIdentity reference
  console.log("\n--- Deploying IntentPool ---");
  const IntentPool = await hre.ethers.getContractFactory("IntentPool");
  const pool = await IntentPool.deploy(identityAddr);
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("IntentPool deployed to:", poolAddr);

  // Summary
  console.log("\n========== Deployment Summary ==========");
  console.log("Network:        ", hre.network.name);
  console.log("AgentIdentity:  ", identityAddr);
  console.log("IntentPool:     ", poolAddr);
  console.log("=========================================");
  console.log(
    "\nUpdate CONTRACT_ADDRESS in employer_sdk/employer_daemon.py,",
    "worker_cli/worker.py, and worker_cli/worker_gateway.py"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
