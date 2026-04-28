# rescontre

TypeScript SDK for Rescontre, a clearinghouse for agent-to-agent payments. Agents
and resource servers record commitments against a bilateral ledger and settle in
periodic batches instead of on every request.

## Why?

Instead of settling every API call on-chain, Rescontre nets obligations and
settles the differences. Up to ~90% fewer settlement transactions.

## Install

```bash
npm install rescontre
```

## Quickstart

The SDK requires an API key for `verify` and `settle` calls. Mint one on the
facilitator with `POST /admin/keys` (operator-only, requires
`X-Internal-Secret`), then either set `RESCONTRE_API_KEY` in your environment
or pass `apiKey` to the client:

```bash
export RESCONTRE_API_KEY=<64-char hex key>
```

```ts
import { Client, Direction } from "rescontre";

// Picks up RESCONTRE_API_KEY from the environment...
const c = new Client("http://localhost:3000");

// ...or pass it explicitly:
const c2 = new Client("http://localhost:3000", { apiKey: "<64-char hex key>" });

await c.registerAgent("agent-1", "0xAAA...");
await c.registerServer("server-1", "0xBBB...", ["/api/data"]);
await c.createAgreement("agent-1", "server-1", {
  creditLimit: 10_000_000,
  settlementFrequency: 100,
});

const check = await c.verify("agent-1", "server-1", 1_000_000, "n-1");
if (!check.valid) throw new Error(check.reason ?? "verify failed");

const receipt = await c.settle(
  "agent-1",
  "server-1",
  1_000_000,
  "n-1",
  "GET /api/data",
  { direction: Direction.AgentToServer },
);
console.log(receipt.commitment_id, receipt.net_position);
```

Amounts are integers in microdollars (`$1 === 1_000_000`).

## Connect

```ts
// Local development
const c = new Client("http://localhost:3000");

// Production
const c = new Client("https://rescontre-production.up.railway.app");
```

```ts
// After multiple settle calls in both directions...
const result = await c.bilateralSettlement("agent-1", "server-1");
console.log(`Gross: $${(result.gross_volume / 1_000_000).toFixed(2)}`);
console.log(`Net:   $${(result.net_amount / 1_000_000).toFixed(2)}`);
console.log(`Compression: ${(result.compression * 100).toFixed(0)}%`);
```

## Examples

End-to-end demo of the x402 → verify → settle → net flow lives in
[`examples/`](./examples). Run against a local backend on `:3000`:

```bash
npx tsx examples/quickstart.ts
```
