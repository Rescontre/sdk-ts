/** End-to-end smoke run of the SDK against a live backend on :3000. */

import { Client } from "../src/client";
import { Direction } from "../src/models";

async function main(): Promise<void> {
    const run = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    const agentId = `agent-${run}`;
    const serverId = `server-${run}`;

    const c = new Client("http://localhost:3000");

    const health = await c.health();
    console.log("health:", health["status"]);

    console.log("register_agent:", await c.registerAgent(agentId, `0xAAA${run}`));
    console.log(
        "register_server:",
        await c.registerServer(serverId, `0xBBB${run}`, ["/api/data"]),
    );
    console.log(
        "create_agreement:",
        await c.createAgreement(agentId, serverId, {
            creditLimit: 10_000_000,
            settlementFrequency: 100,
        }),
    );

    const check = await c.verify(agentId, serverId, 1_000_000, `${run}-n1`);
    console.log("verify:", check);
    if (!check.valid) {
        throw new Error(check.reason ?? "verify failed");
    }

    const receipt = await c.settle(
        agentId,
        serverId,
        1_000_000,
        `${run}-n1`,
        "GET /api/data",
        { direction: Direction.AgentToServer },
    );
    console.log("settle:", receipt);
    if (!receipt.settled) {
        throw new Error("not settled");
    }
    if (receipt.commitment_id !== `${run}-n1`) {
        throw new Error(`commitment_id mismatch: ${receipt.commitment_id}`);
    }
    if (receipt.net_position !== 1_000_000) {
        throw new Error(`net_position mismatch: ${receipt.net_position}`);
    }

    console.log("\nOK — end-to-end verified.");
}

main().catch((err) => {
    console.error(err);
    throw err;
});
