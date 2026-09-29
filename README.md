# x402 AI-Agent Paywall Demo (Akamai Functions)

Working end-to-end demo: Akamai edge detects AI-agent traffic hitting the example publisher site
`www.publisher.example` → routes it to a Spin app on Akamai Functions
(`x402-paywall`) → app returns HTTP 402 with x402 payment terms → agent
signs and pays in test USDC on Base Sepolia → app verifies/settles via
the `x402.org` facilitator → app fetches and returns the real page
content with a `200 OK`.

## Project layout

```
wallets/            generate + fund the two demo wallets (agent, publisher)
agent-simulator/    a Node script that plays the role of a paying AI agent
x402-paywall/       the actual Spin/WebAssembly app deployed to Akamai Functions
```

`x402-paywall/` is scaffolded directly from Akamai's own `spin new` template
(see below) rather than hand-written from scratch, so its `spin.toml` and
`package.json` match whatever SDK versions Akamai Functions expects.

## Publisher hostname

`www.publisher.example` is an example hostname, not a live publisher
site. Before deploying this demo, replace it with a hostname you control in
`x402-paywall/spin.toml` (both `origin_url` and `allowed_outbound_hosts`),
`x402-paywall/src/index.js` (`EXAMPLE_PUBLISHER_ORIGIN`), and your Akamai
Property Manager configuration. Keep the origin hostname consistent across
those settings.

## Prerequisites

1. Akamaized Hostname
2. Botman enabled on hostname
3. Have access to create Akamai Functions
4. Spin CLI installed
5. Basic understanding of how x402 works

## Environment files

The `.env.example` files are templates and their placeholder values must be
replaced before running the demo. Create a local `.env` from the relevant
template, fill in real values, and never commit the resulting `.env` files:

- The wallet scripts use a root `.env`. `node wallets/generate-wallets.mjs`
  creates it with fresh demo wallet keys; then fill in any required URL values.
  If supplying your own wallets instead, copy `.env.example` to `.env` at the
  repository root and replace every placeholder.
- The agent simulator loads its own env file from `agent-simulator/`. Copy
  `agent-simulator/.env.example` to `agent-simulator/.env` and set its values,
  including the same `AGENT_PRIVATE_KEY` and `AGENT_ADDRESS` as the root `.env`.

Do not run the balance checker or simulator with the example placeholders.

## Build order

1. **Wallets** — generate two throwaway Base Sepolia keypairs (agent =
   payer, publisher = payee):

   ```
   cd wallets
   npm install          # installs viem + dotenv (scoped to this folder's own package.json)
   node generate-wallets.mjs
   cd ..
   ```

   This writes a git-ignored `.env` at the repo root with
   `AGENT_PRIVATE_KEY` / `AGENT_ADDRESS` / `PUBLISHER_PRIVATE_KEY` /
   `PUBLISHER_ADDRESS`, plus placeholders for `BASE_SEPOLIA_RPC_URL`,
   `FACILITATOR_URL`, and `RESOURCE_URL`.

   **Fund the agent wallet with test USDC** — this is the wallet that
   actually pays for each request, and the demo will fail with
   `invalid_exact_evm_insufficient_balance` until it holds enough:
   - USDC: https://faucet.circle.com → select **Base Sepolia**, paste
     `AGENT_ADDRESS`, request USDC. The default price is `10000` atomic
     units = **0.01 USDC** (6 decimals) per request, so even the smallest
     faucet drip covers many requests.
   - ETH: optional. For the `exact` x402 scheme, the **facilitator**
     submits the on-chain settlement transaction and pays its own gas —
     the agent only needs to _sign_ an EIP-3009
     `transferWithAuthorization` message, not send a transaction. ETH is
     only useful here as a safety margin, from
     https://www.alchemy.com/faucets/base-sepolia.

   Confirm funds landed:

   ```
   node wallets/check-balances.mjs
   ```

   This checks both `AGENT_ADDRESS` and `PUBLISHER_ADDRESS` for ETH and
   USDC balances (USDC contract: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
   on Base Sepolia — double check this against
   https://developers.circle.com/stablecoins/usdc-contract-addresses since
   testnet contract addresses occasionally change).

2. **Spin app (`x402-paywall/`)** — scaffold with Akamai's own template so
   you get the exact SDK versions Akamai Functions expects:

   ```
   spin new -E akamai-functions -t http-js --accept-defaults x402-paywall
   cd x402-paywall
   npm install
   ```

   The generated `src/index.js` and `spin.toml` in this repo already
   contain the working paywall logic (see "How the paywall app works"
   below) — copy them into the generated project if you're re-scaffolding
   from scratch, adjusting import paths if `spin new` pins a different
   SDK version than referenced here.

   Build and deploy:

   ```
   spin build
   spin aka login
   spin aka deploy --variable publisher_address=<PUBLISHER_ADDRESS from .env>
   ```

   Note the deployed URL (e.g. `https://<app-id>.aka.fermyon.tech`) — set
   it as `RESOURCE_URL` in `agent-simulator/.env` for local testing before
   Property Manager is wired up.

   Tail logs while debugging the payment flow:

   ```
   spin aka logs -n 50
   ```

3. **Property Manager** — to route AI-agent traffic on your publisher hostname
   to the deployed app.

4. **Agent simulator** — plays the AI agent that hits the paywall and pays:

   ```
   cd agent-simulator
   npm install          # x402-fetch, viem, dotenv (scoped to this folder's own package.json)
   ```

   Set `RESOURCE_URL` in `agent-simulator/.env` to a real page on the
   property (staging hostname first, or the raw Functions app URL), then:

   ```
   node agent.mjs [/optional-path]
   ```

   - With no path argument, it requests `RESOURCE_URL` as-is.
   - With a path argument, it resolves that path against `RESOURCE_URL`'s
     origin.

   Expected flow, printed to the console:
   1. Plain request → **402** with x402 payment terms (price, asset,
      `payTo`, network, `resource`).
   2. `x402-fetch` automatically selects a payment requirement, builds and
      signs an EIP-3009 `transferWithAuthorization` payload with the
      agent's wallet, and retries with an `X-PAYMENT` header.
   3. Server verifies the payload with the facilitator, settles it
      on-chain, then proxies the real page from origin.
   4. Final status **200**, plus an `X-Payment-Response` header containing
      the settlement receipt (`txHash`).

## How the paywall app works (`x402-paywall/src/index.js`)

Akamai's edge (Property Manager, see step 3) has already decided a
request looks like an AI agent before it reaches this app, and forwards
it here instead of the real origin with:

- `X-Detected-Agent: true`
- `X-Original-Host: <the real publisher hostname>`

On each request:

1. If `X-Detected-Agent` is missing, fail safe and proxy straight to
   origin with no paywall (this app should only ever see agent traffic).
2. Check the Spin KV store for an "already paid" flag keyed by client IP
   - resource path, so repeated asset requests within
     `PAID_CACHE_SECONDS` (5 min) aren't re-charged.
3. No `X-PAYMENT` header → return `402` with payment requirements built
   from Spin variables (`facilitator_url`, `publisher_address`,
   `origin_url`, `price_atomic_usdc`, `network`, `usdc_asset_address`).
   Each requirement includes an `extra: { name: "USDC", version: "2" }`
   field — this is the EIP-712 domain (name/version) the facilitator
   needs to validate the token's `transferWithAuthorization` signature;
   without it the facilitator rejects with
   `invalid_exact_evm_missing_eip712_domain`.
4. `X-PAYMENT` present → POST to the facilitator's `/verify`, then
   `/settle` endpoints. **Important:** the facilitator's verify/settle
   APIs expect a single requirement object (`scheme`/`network` at the top
   level), not the `{ x402Version, error, accepts: [...] }` wrapper
   returned in the 402 body — send `paymentRequirements.accepts[0]`, not
   the wrapper, or you'll get
   `"No facilitator registered for scheme: undefined and network: undefined"`.
5. On successful settlement, mark the KV cache, proxy the real content
   from `X-Original-Host` (falling back to `origin_url`), and attach an
   `X-Payment-Response` header with the settlement receipt.
6. Every outbound request to the configured example publisher origin gets an
   `x-af-processed: true` header added.

Failure responses always include an `invalidReason` (e.g.
`facilitator_verify_unreachable`, `invalid_exact_evm_insufficient_balance`,
`settlement_failed`) instead of a bare, unexplained 402 — check
`spin aka logs` for the full facilitator error text if that's not enough.

Outbound HTTP is locked down via `allowed_outbound_hosts` in `spin.toml`
to just the facilitator and the real origin — Spin blocks any other
outbound host by default.

## Troubleshooting notes from getting this working

These were the actual issues hit while wiring this demo up, in case they
recur:

- **`spin new -E ...` errors with `unexpected argument`** — you have the
  stock open-source Spin CLI installed, not Akamai's fork. Reinstall via
  `fwf_install.sh` (see Prerequisites).
- **`npm install` in a subfolder installs unrelated/vulnerable packages**
  — if a subfolder has no `package.json`, npm walks up to the nearest
  ancestor one and installs there. Give every subfolder (`wallets/`,
  `agent-simulator/`) its own `package.json`.
- **TOML parse error on `variables = { default = ... }`** — variable
  _definitions_ (`default`/`required`) belong in a top-level `[variables]`
  table; `[component.<name>.variables]` only maps names to `"{{ template }}"`
  string references.
- **`Cannot find package 'esbuild'`** — `npm install` hadn't been run in
  `x402-paywall/` yet.
- **`cannot read wasm module ".../target/..."`** — the component's
  `npm run build` script outputs to `dist/`, but `spin.toml`'s
  `[component.x402-paywall] source` pointed at `target/`. They must match.
- **`ZodError: Invalid url` on `resource`** — the 402 body's `resource`
  field must be a full absolute URL, not just a path.
- **`client.account.address is undefined`** — `wrapFetchWithPayment`
  needs a viem `WalletClient` (`createWalletClient`), not a bare `Account`
  from `privateKeyToAccount`.
- **`client.readContract is not a function`** — extend the wallet client
  with `publicActions` (`.extend(publicActions)`) so x402 can read the
  token's on-chain version.
- **`InvalidAddressError` on the USDC asset address** — a single hex
  character had been dropped when the address was copied into `spin.toml`;
  always diff it against a known-good source (e.g.
  `wallets/check-balances.mjs`).
- **`"No facilitator registered for scheme: undefined..."`** — the server
  was sending the whole `{accepts:[...]}` wrapper to `/verify` and
  `/settle` instead of a single requirement object.
- **`invalid_exact_evm_missing_eip712_domain`** — the requirement object
  needs an `extra: { name, version }` field for the token's EIP-712 domain.
- **`invalid_exact_evm_insufficient_balance`** — the agent wallet just
  isn't funded with enough USDC yet; fund it and re-check with
  `check-balances.mjs`.

## What's real vs. simplified in this demo

- **Real:** x402 protocol shape, Base Sepolia testnet settlement, Akamai
  Property Manager routing pattern, Spin KV usage for de-duping charges.
- **Simplified for a demo:** the "already paid" cache is a flat KV flag
  with an ad-hoc TTL check rather than a proper session/wallet-bound
  entitlement system; the User-Agent match list in the Property Manager
  doc is a starting point, not an exhaustive/maintained bot signature
  list (that's what Bot Manager's managed category is for in production);
  error handling in `index.js` is minimal (demo-grade, not
  production-hardened against malformed payment payloads, replay, etc.).

## Before this goes anywhere near production

- Verify the exact x402 request/response schema against the facilitator
  you actually settle with (Coinbase's hosted one, or your own) - field
  names have moved between x402 protocol versions.
- Add replay protection (a `nonce` + KV check) so a captured X-PAYMENT
  header can't be reused.
- Decide a real pricing/session model (per-request vs. a prepaid credit
  balance per agent) rather than literal pay-per-hit, since per-request
  onchain settlement latency adds up on a page with many assets.
