# rescontre

TypeScript SDK for [Rescontre](https://rescontre.com) — payment operations
for agent and API traffic. Send your payment and job lifecycle events;
Rescontre builds one canonical receipt timeline per interaction, detects
issues (paid-not-delivered, duplicates, missing refunds, …), and backs every
number with hashed source evidence.

Rescontre observes and reconciles. It does not custody funds, initiate
transfers, or settle payments on your behalf.

## Install

```bash
npm install rescontre
```

## Quickstart

Every call is authenticated with an API key: set `RESCONTRE_API_KEY` in your
environment or pass `apiKey` to the client.

```ts
import { Client } from "rescontre";

const c = new Client("https://rescontre-production.up.railway.app");

// A customer's agent called your paid tool: record what happened.
await c.sendEvent({
  eventType: "payment.succeeded",
  correlationId: "job-42",       // ties events into one receipt
  source: "my-app",              // your system's name
  externalId: "pi_3PqX...",      // the upstream id (Stripe intent, tx hash, ...)
  amount: 1_000_000,             // microdollars: $1 === 1_000_000
  currency: "USD",
  providerId: "tool-server-1",
  payload: { stripeEvent: "..." }, // retained redacted + hashed as evidence
});
await c.sendEvent({
  eventType: "tool.delivered",
  correlationId: "job-42",
  source: "my-app",
  externalId: "run-981",
  toolName: "search",
});

// The receipt timeline for that interaction:
const receipt = await c.getReceipt("job-42");

// Anything unresolved across all your traffic:
const inbox = await c.listIssues(); // open issues by default

// Search receipts by any operational handle:
const hits = await c.searchReceipts({ provider: "tool-server-1", since: 1752000000 });
```

### Event types

`POST /events` accepts a closed vocabulary (anything else is a 400):

| Family | Types |
| --- | --- |
| Payment | `payment.initiated`, `payment.succeeded`, `payment.failed`, `payment.refunded` |
| Tool / job | `tool.requested`, `tool.delivered`, `tool.failed` |
| Dispute | `dispute.opened`, `dispute.resolved` |

`amount` (microdollars, > 0) is required for `payment.succeeded` and
`payment.refunded` — an observed transfer without an amount is not evidence
of anything.

### Retries and idempotency

`sendEvent` retries transient failures (network errors, timeouts, 429/5xx)
with backoff, and this is safe by design: the server deduplicates on
`(source, external_id, event_type)`. If a send actually landed but the
response was lost, the retry returns `duplicate: true` — an idempotent
success, never a double record. 4xx responses are never retried. The
schedule is configurable via `new Client(url, { retryBackoffMs: [...] })`.

Give each distinct real-world occurrence its own `externalId` (your job id,
the Stripe intent id, the tx hash) and reuse it on resends.

### Evidence semantics

The server hashes the **exact raw request body** it receives (SHA-256,
before parsing or redaction), then retains your `payload` **redacted**. The
hash proves byte-for-byte what was sent; the redaction keeps secrets out of
storage. Source names prefixed `rail:` or `webhook:` are reserved for
Rescontre's own rail-verified ingestion, so customer-sent and rail-verified
evidence stay distinguishable forever.

## Legacy clearinghouse endpoints

Earlier versions of this SDK targeted Rescontre's clearing surface
(`registerAgent`, `registerServer`, `createAgreement`, `verify`, `settle`,
`bilateralSettlement`). Those methods still work against legacy deployments,
but ops-product deployments run with `OPS_MODE=true`, where money-movement
endpoints are disabled and respond `403`. New integrations should use the
events/receipts/issues surface above.

## Examples

End-to-end demos of the **legacy clearinghouse flow** live in
[`examples/`](./examples). Run against a local backend on `:3000`:

```bash
npx tsx examples/quickstart.ts
```
