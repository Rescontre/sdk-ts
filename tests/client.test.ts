import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    AuthenticationError,
    Client,
    Direction,
    RescontreAPIError,
    RescontreConfigurationError,
} from "../src/index";

const API_KEY = "a".repeat(64);

interface CapturedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

function makeMockFetch(
    responder: (req: CapturedCall) => { status?: number; body?: unknown },
): { fetch: typeof fetch; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const mock: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const headers: Record<string, string> = {};
        const rawHeaders = init?.headers;
        if (rawHeaders) {
            const entries =
                rawHeaders instanceof Headers
                    ? Array.from(rawHeaders.entries())
                    : Array.isArray(rawHeaders)
                      ? rawHeaders
                      : Object.entries(rawHeaders as Record<string, string>);
            for (const [k, v] of entries) {
                headers[k.toLowerCase()] = String(v);
            }
        }
        let body: unknown = undefined;
        if (typeof init?.body === "string") {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        const captured: CapturedCall = { url, method, headers, body };
        calls.push(captured);

        const { status = 200, body: respBody = {} } = responder(captured);
        const text = typeof respBody === "string" ? respBody : JSON.stringify(respBody);
        return new Response(text, {
            status,
            headers: { "Content-Type": "application/json" },
        });
    };
    return { fetch: mock, calls };
}

describe("Client construction", () => {
    const env = (
        globalThis as unknown as {
            process: { env: Record<string, string | undefined> };
        }
    ).process.env;
    const ORIGINAL_ENV = env["RESCONTRE_API_KEY"];

    beforeEach(() => {
        delete env["RESCONTRE_API_KEY"];
    });

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) {
            delete env["RESCONTRE_API_KEY"];
        } else {
            env["RESCONTRE_API_KEY"] = ORIGINAL_ENV;
        }
    });

    it("throws RescontreConfigurationError when no key is set", () => {
        expect(() => new Client("http://test")).toThrow(RescontreConfigurationError);
        try {
            new Client("http://test");
        } catch (e) {
            const msg = (e as Error).message;
            expect(msg).toContain("apiKey");
            expect(msg).toContain("RESCONTRE_API_KEY");
        }
    });

    it("picks up RESCONTRE_API_KEY from the environment", async () => {
        env["RESCONTRE_API_KEY"] = API_KEY;
        const { fetch: mockFetch, calls } = makeMockFetch(() => ({
            body: { valid: true, reason: null, remaining_credit: 0 },
        }));
        const c = new Client("http://test", { fetch: mockFetch });
        await c.verify("a", "s", 1, "n");
        expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    });

    it("accepts apiKey via constructor option", () => {
        expect(() => new Client("http://test", { apiKey: API_KEY })).not.toThrow();
    });
});

describe("X-API-Key header routing", () => {
    it("sends header on /internal/verify and /internal/settle, not on public endpoints", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch((req) => {
            if (req.url.endsWith("/internal/verify")) {
                return { body: { valid: true, reason: null, remaining_credit: 100 } };
            }
            if (req.url.endsWith("/internal/settle")) {
                return {
                    body: {
                        settled: true,
                        commitment_id: "cmt-1",
                        net_position: 1_000_000,
                        commitments_until_settlement: 99,
                    },
                };
            }
            return { body: { ok: true } };
        });

        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });
        await c.registerAgent("a", "0xAAA");
        await c.registerServer("s", "0xBBB", ["/api/data"]);
        await c.createAgreement("a", "s", { creditLimit: 10, settlementFrequency: 1 });
        await c.verify("a", "s", 1, "n");
        await c.settle("a", "s", 1, "n", "GET /api/data", {
            direction: Direction.AgentToServer,
        });

        const headerByPath: Record<string, string | undefined> = {};
        for (const call of calls) {
            const path = new URL(call.url).pathname;
            headerByPath[path] = call.headers["x-api-key"];
        }

        expect(headerByPath["/internal/verify"]).toBe(API_KEY);
        expect(headerByPath["/internal/settle"]).toBe(API_KEY);
        expect(headerByPath["/agents"]).toBeUndefined();
        expect(headerByPath["/servers"]).toBeUndefined();
        expect(headerByPath["/agreements"]).toBeUndefined();
    });
});

describe("401 handling", () => {
    it("verify throws AuthenticationError on 401", async () => {
        const { fetch: mockFetch } = makeMockFetch(() => ({
            status: 401,
            body: { error: "invalid api key" },
        }));
        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });
        await expect(c.verify("a", "s", 1, "n")).rejects.toBeInstanceOf(
            AuthenticationError,
        );
        try {
            await c.verify("a", "s", 1, "n");
        } catch (e) {
            const err = e as AuthenticationError;
            expect(err.status_code).toBe(401);
            expect(err.message).toContain("RESCONTRE_API_KEY");
            expect(err.message).toContain("/admin/keys");
        }
    });

    it("settle throws AuthenticationError on 401", async () => {
        const { fetch: mockFetch } = makeMockFetch(() => ({
            status: 401,
            body: { error: "invalid api key" },
        }));
        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });
        await expect(
            c.settle("a", "s", 1, "n", "GET /x", {
                direction: Direction.AgentToServer,
            }),
        ).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("does not retry on 401 (single fetch call)", async () => {
        const fetchSpy = vi.fn(async () =>
            new Response(JSON.stringify({ error: "nope" }), {
                status: 401,
                headers: { "Content-Type": "application/json" },
            }),
        );
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: fetchSpy as unknown as typeof fetch,
        });
        await expect(c.verify("a", "s", 1, "n")).rejects.toBeInstanceOf(
            AuthenticationError,
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("non-401 errors still raise RescontreAPIError (not AuthenticationError)", async () => {
        const { fetch: mockFetch } = makeMockFetch(() => ({
            status: 400,
            body: { error: "insufficient credit" },
        }));
        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });
        try {
            await c.verify("a", "s", 1, "n");
            throw new Error("expected throw");
        } catch (e) {
            expect(e).toBeInstanceOf(RescontreAPIError);
            expect(e).not.toBeInstanceOf(AuthenticationError);
            expect((e as RescontreAPIError).status_code).toBe(400);
        }
    });
});
