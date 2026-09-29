// index.js
// Runs on Akamai Functions (Spin/WebAssembly). Akamai's edge property has
// already decided "this request looks like an AI agent" before it ever
// reaches this app (see docs/PROPERTY_MANAGER_SETUP.md) and has:
//   - routed the request here instead of the real origin
//   - set X-Detected-Agent: true
//   - set X-Original-Host: <the real publisher hostname>
//
// This app's job:
//   1. If the request has no valid X-PAYMENT header -> return HTTP 402 with
//      x402 payment requirements (price, asset, payTo, network).
//   2. If it has X-PAYMENT -> verify + settle with the x402 facilitator.
//   3. On success -> fetch the real content from ORIGIN_URL and return it,
//      caching "already paid" in the KV store for a short window so a
//      single agent session isn't charged per-asset-on-the-page.
//
// NOTE: This is demo-grade. Before production use, validate the exact
// 402 response schema and facilitator request/response shapes against
// the current x402 spec (https://www.x402.org) and your chosen
// facilitator's API docs - the protocol is still evolving and field
// names have shifted between versions.

import { AutoRouter } from "itty-router";
import { openDefault } from "@spinframework/spin-kv";
//import { Kv } from "@spinframework/spin-kv";
import { get as getVariable } from "@spinframework/spin-variables";

const PAID_CACHE_SECONDS = 300; // don't re-charge the same agent+resource for 5 min

const router = AutoRouter();

router.all("*", async (request) => {
  const cfg = {
    facilitatorUrl: getVariable("facilitator_url"),
    publisherAddress: getVariable("publisher_address"),
    originUrl: getVariable("origin_url"),
    priceAtomic: getVariable("price_atomic_usdc"),
    network: getVariable("network"),
    asset: getVariable("usdc_asset_address"),
  };

  const url = new URL(request.url);
  const resourcePath = url.pathname;
  const detectedAgent = request.headers.get("x-detected-agent");
  const originalHost = request.headers.get("x-original-host") || cfg.originUrl;

  // If Akamai didn't flag this as agent traffic, this app shouldn't have
  // been hit at all (Property Manager routes only agent traffic here) -
  // but fail safe and just proxy straight through with no paywall.
  if (!detectedAgent) {
    return proxyToOrigin(originalHost, request, resourcePath);
  }

  const paymentHeader = request.headers.get("x-payment");
  const store = openDefault();
  const cacheKey = paymentCacheKey(request, resourcePath);

  // Already paid recently? Skip straight to content.
  const alreadyPaid = store.get(cacheKey);
  if (alreadyPaid) {
    return proxyToOrigin(originalHost, request, resourcePath);
  }

  const paymentRequirements = buildPaymentRequirements(
    cfg,
    resourcePath,
    originalHost,
  );
  // Facilitator's verify/settle APIs expect a single requirement object
  // (scheme/network at the top level), not the {accepts:[...]} wrapper.
  const selectedRequirement = paymentRequirements.accepts[0];

  if (!paymentHeader) {
    return json402(paymentRequirements);
  }

  // Verify, then settle, with the facilitator.
  const verifyResult = await callFacilitator(cfg.facilitatorUrl, "verify", {
    x402Version: 1,
    paymentPayload: safeJsonParse(atob(paymentHeader)),
    paymentRequirements: selectedRequirement,
  });

  if (!verifyResult?.isValid) {
    return json402(
      paymentRequirements,
      402,
      verifyResult?.invalidReason || "facilitator_verify_unreachable",
    );
  }

  const settleResult = await callFacilitator(cfg.facilitatorUrl, "settle", {
    x402Version: 1,
    paymentPayload: safeJsonParse(atob(paymentHeader)),
    paymentRequirements: selectedRequirement,
  });

  if (!settleResult?.success) {
    return json402(paymentRequirements, 402, "settlement_failed");
  }

  // Mark as paid for PAID_CACHE_SECONDS so repeated asset requests on the
  // same page load don't each trigger a fresh charge.
  store.set(cacheKey, "1");
  // NOTE: TTL/expiry on Spin's default KV depends on the store backend;
  // if there's no native TTL, store a timestamp instead and check age.

  const response = await proxyToOrigin(originalHost, request, resourcePath);
  response.headers.set(
    "X-Payment-Response",
    btoa(JSON.stringify({ success: true, txHash: settleResult.transaction })),
  );
  return response;
});

function paymentCacheKey(request, resourcePath) {
  // Keyed by payer address (once known) or, before payment, by a coarse
  // client fingerprint. Simplest demo version: hash of IP + resource path.
  const clientIp = request.headers.get("x-forwarded-for") || "unknown";
  return `paid:${clientIp}:${resourcePath}`;
}

function buildPaymentRequirements(cfg, resourcePath, originalHost) {
  const resource = new URL(resourcePath, ensureScheme(originalHost)).toString();
  return {
    x402Version: 1,
    error: "Payment required to access this resource as an automated agent",
    accepts: [
      {
        scheme: "exact",
        network: cfg.network,
        maxAmountRequired: cfg.priceAtomic,
        resource,
        description: "Per-request access fee for AI agent traffic",
        mimeType: "text/html",
        payTo: cfg.publisherAddress,
        maxTimeoutSeconds: 60,
        asset: cfg.asset,
        // Required by facilitators to build the EIP-712 domain for the
        // asset's EIP-3009 transferWithAuthorization signature.
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function json402(paymentRequirements, status = 402, reason) {
  const body = { ...paymentRequirements };
  if (reason) body.invalidReason = reason;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function callFacilitator(facilitatorUrl, action, payload) {
  const res = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.error(
      `facilitator ${action} failed: ${res.status} ${res.statusText} - ${bodyText}`,
    );
    return null;
  }
  return res.json();
}

const EXAMPLE_PUBLISHER_ORIGIN = "https://www.publisher.example";

async function proxyToOrigin(originalHost, request, resourcePath) {
  const targetUrl = new URL(
    resourcePath,
    ensureScheme(originalHost),
  ).toString();
  const outboundHeaders = stripHopByHopHeaders(request.headers);
  if (targetUrl.startsWith(EXAMPLE_PUBLISHER_ORIGIN)) {
    outboundHeaders.set("x-af-processed", "true");
  }
  const originResponse = await fetch(targetUrl, {
    method: request.method,
    headers: outboundHeaders,
  });
  // Clone so we can safely add headers before returning.
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers: originResponse.headers,
  });
}

function ensureScheme(host) {
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

function stripHopByHopHeaders(headers) {
  const out = new Headers(headers);
  ["x-payment", "x-detected-agent", "connection", "keep-alive"].forEach((h) =>
    out.delete(h),
  );
  return out;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(router.fetch(event.request));
});
