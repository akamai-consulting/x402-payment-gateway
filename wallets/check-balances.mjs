// check-balances.mjs
// Confirms ETH (gas) and USDC balances for both demo wallets on Base Sepolia.
//
// Usage:
//   npm install viem dotenv
//   node check-balances.mjs

import "dotenv/config";
import { createPublicClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

// Circle's canonical USDC contract on Base Sepolia
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Note: verify this against Circle's current testnet contract list before relying on it -
// testnet contract addresses occasionally change. See https://developers.circle.com/stablecoins/usdc-contract-addresses

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
];

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"),
});

async function report(label, address) {
  const ethBalance = await client.getBalance({ address });
  const usdcBalance = await client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  });

  console.log(`\n${label} (${address})`);
  console.log(`  ETH:  ${formatUnits(ethBalance, 18)}`);
  console.log(`  USDC: ${formatUnits(usdcBalance, 6)}`);
}

async function main() {
  if (!process.env.AGENT_ADDRESS || !process.env.PUBLISHER_ADDRESS) {
    console.error("Missing AGENT_ADDRESS / PUBLISHER_ADDRESS - run generate-wallets.mjs first.");
    process.exit(1);
  }
  await report("AGENT", process.env.AGENT_ADDRESS);
  await report("PUBLISHER", process.env.PUBLISHER_ADDRESS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
