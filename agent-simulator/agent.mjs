// agent.mjs
// Simulates an AI agent crawling/fetching a paywalled publisher resource.
// Uses x402-fetch, which handles the whole handshake for you:
//   1. plain fetch()
//   2. server returns 402 with payment requirements
//   3. x402-fetch signs an EIP-3009 authorization with the agent's wallet
//   4. retries the request with the X-PAYMENT header attached
//   5. returns the final (paid, 200 OK) response
//
// Usage:
//   npm install x402-fetch viem dotenv
//   node agent.mjs [path]
//
// Set an explicit User-Agent so Akamai's edge classifies this as an AI agent
// even without a real crawler in the loop.

import "dotenv/config";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
const RESOURCE_URL = process.env.RESOURCE_URL; // e.g. https://<app>.aka.fermyon.tech/some-article
const AGENT_USER_AGENT =
  process.env.AGENT_USER_AGENT || "GPTBot/1.1 (+https://openai.com/gptbot)";
const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

if (!AGENT_PRIVATE_KEY || !RESOURCE_URL) {
  console.error("Missing AGENT_PRIVATE_KEY or RESOURCE_URL in .env");
  process.exit(1);
}

const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
// x402-fetch needs a viem WalletClient (to sign) extended with public
// actions (readContract), since it reads the EIP-3009 token's version.
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA_RPC_URL),
}).extend(publicActions);

// wrapFetchWithPayment intercepts 402 responses, signs payment, and retries.
const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

async function main() {
  const path = process.argv[2];
  const url = path ? new URL(path, RESOURCE_URL).toString() : RESOURCE_URL;

  console.log(`[agent] requesting ${url} as ${account.address}`);
  console.log(`[agent] pretending to be: ${AGENT_USER_AGENT}`);

  const res = await fetchWithPayment(url, {
    headers: {
      "User-Agent": AGENT_USER_AGENT,
      "x-ai-agent": "true",
    },
  });

  console.log(`[agent] final status: ${res.status}`);
  const paymentResponseHeader = res.headers.get("x-payment-response");
  if (paymentResponseHeader) {
    console.log(`[agent] settlement receipt: ${paymentResponseHeader}`);
  }

  const body = await res.text();
  const preview = res.status === 402 ? body : body.slice(0, 500);
  console.log(`[agent] body:\n${preview}`);
}

main().catch((err) => {
  console.error("[agent] request failed:", err);
  process.exit(1);
});
