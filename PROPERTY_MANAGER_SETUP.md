# Wiring www.publisher.example to the x402 paywall

Goal: AI-agent traffic gets routed to the Spin app on Akamai Functions
(which paywalls it via x402), while every other visitor keeps hitting the
real origin untouched.

Do this in a **new version** of the existing property, test on staging,
then activate to production.

## 0. Deploy the Functions app first

```
cd spin-app
spin aka login
spin build
spin aka deploy --variable publisher_address=<PUBLISHER_ADDRESS from .env>
```

Note the stable URL it gives you, e.g. `https://<app-id>.aka.fermyon.tech`.
That's `<FUNCTIONS_APP_URL>` below.

## 1. Create a new rule: "Route AI Agents to Paywall"

In Property Manager, under the default rule, add a child rule.

**Match criteria** (match ANY of these — use "Or" logic):

If you have Bot Manager licensed on this config:

- Condition: `Bot Category` **equals** the Akamai-defined AI Agents/AI Bots
  category (name varies by Bot Manager version — check
  Security Configuration > Bot Management > Category list for the exact
  label on your account).

If you don't have Bot Manager, match on User-Agent instead:

- Condition: `User-Agent` header **matches wildcard** — add one condition
  per pattern, OR'd together. Note that request headers can never be trusted and should be used only for demo:
  - `*GPTBot*`
  - `*ChatGPT-User*`
  - `*ClaudeBot*`
  - `*PerplexityBot*`
  - `*Google-Extended*`
  - `*CCBot*`
  - `*Bytespider*`

(Extend this list over time — new agent user-agents show up regularly.
Akamai's Bot Manager category is the more durable solution since Akamai
maintains the signature list for you, based on multiple signals, not only request headers.)

## 2. Set Origin behavior on this rule

- Origin type: **Custom origin**
- Origin hostname: `<FUNCTIONS_APP_URL>` (no scheme, no trailing slash)
- Forward host header: **Origin Hostname** (do NOT forward the original
  `www.publisher.example` host here — the Functions app needs to know
  it's being hit directly so it can run its own logic first)
- Origin SSL: enabled, standard TLS validation
- Disable SS for traffic coming on Akamai Function Origin.

## 3. Modify Outgoing Request Headers behavior (on the same rule)

Add these headers to the outgoing request (the one Akamai sends to the
Functions app):

| Header             | Value                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `X-Detected-Agent` | `true`                                                                                         |
| `X-Original-Host`  | `{{builtin.AK_HOST}}`                                                                          |
| `X-Agent-Category` | the matched Bot Manager category name, or a literal string if you're doing User-Agent matching |

`X-Original-Host` is what lets the Spin app proxy back to the real content
once payment clears, without hardcoding your domain into the app.

## 4. Leave the default rule untouched

Everything that doesn't match the AI-agent condition (regular browsers,
Googlebot's normal crawler, etc.) continues to hit your existing origin
exactly as it does today. This rule is additive — order it so it only
fires on the AI-agent match, and make sure it sits **above** any caching
rule that might serve a cached human-facing page to a request this rule
should have caught.

## 5. Allow the round-trip through security products

If Bot Manager or App & API Protector would otherwise challenge or block
outbound calls to `<FUNCTIONS_APP_URL>`:

- Add an allowlist entry for Akamai's own edge-to-origin traffic to that
  hostname (this is Akamai calling Akamai, not third-party traffic).

## 6. Test on staging first

```
curl -H "User-Agent: GPTBot/1.1 (+https://openai.com/gptbot)" \
     -H "Host: www.publisher.example" \
     https://<staging-hostname>/some-listing
```

Expected: `HTTP/1.1 402 Payment Required` with a JSON body describing the
payment terms. Then run `node agent-simulator/agent.mjs /some-listing`
pointed at the staging hostname to complete the full paid flow and confirm
you get real page content back with a `200 OK`.

Once that works end to end, activate the property version to production.
