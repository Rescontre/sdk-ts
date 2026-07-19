import { describe, expect, it, vi } from "vitest";

import {
    Client,
    RescontreAPIError,
    RescontreError,
} from "../src/index";

const API_KEY = "a".repeat(64);
// Retries without waiting so tests stay fast.
const NO_WAIT = { retryBackoffMs: [0, 0, 0] as const };

interface CapturedCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

function makeMockFetch(
    responder: (req: CapturedCall, callIndex: number) => { status?: number; body?: unknown },
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

        const { status = 200, body: respBody = {} } = responder(captured, calls.length - 1);
        return new Response(JSON.stringify(respBody), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    };
    return { fetch: mock, calls };
}

const OK_INGEST = {
    recorded: true,
    duplicate: false,
    event_id: 7,
    correlation_id: "job-1",
};

describe("sendEvent", () => {
    it("posts the snake_case body with the API key and omits undefined optionals", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch(() => ({ body: OK_INGEST }));
        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });

        const result = await c.sendEvent({
            eventType: "payment.succeeded",
            correlationId: "job-1",
            source: "my-app",
            externalId: "pi_123",
            amount: 1_000_000,
            currency: "USD",
            providerId: "server-1",
        });

        expect(result.recorded).toBe(true);
        expect(result.event_id).toBe(7);
        const call = calls[0]!;
        expect(new URL(call.url).pathname).toBe("/events");
        expect(call.headers["x-api-key"]).toBe(API_KEY);
        const body = call.body as Record<string, unknown>;
        expect(body["event_type"]).toBe("payment.succeeded");
        expect(body["external_id"]).toBe("pi_123");
        expect(body["amount"]).toBe(1_000_000);
        expect("tool_name" in body).toBe(false);
        expect("payload" in body).toBe(false);
    });

    it("retries on 5xx then succeeds (duplicate is an idempotent success)", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch((_req, i) =>
            i < 2
                ? { status: 500, body: { error: "event persistence failed" } }
                : { body: { ...OK_INGEST, duplicate: true, event_id: null } },
        );
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: mockFetch,
            ...NO_WAIT,
        });

        const result = await c.sendEvent({
            eventType: "tool.delivered",
            correlationId: "job-1",
            source: "my-app",
            externalId: "run-9",
        });

        expect(calls.length).toBe(3);
        expect(result.duplicate).toBe(true);
    });

    it("retries network errors", async () => {
        let attempts = 0;
        const flaky: typeof fetch = async (...args) => {
            attempts++;
            if (attempts === 1) {
                throw new TypeError("fetch failed");
            }
            return new Response(JSON.stringify(OK_INGEST), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        };
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: flaky,
            ...NO_WAIT,
        });
        const result = await c.sendEvent({
            eventType: "tool.requested",
            correlationId: "job-1",
            source: "my-app",
            externalId: "run-1",
        });
        expect(attempts).toBe(2);
        expect(result.recorded).toBe(true);
    });

    it("does not retry 4xx", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch(() => ({
            status: 400,
            body: { error: "occurred_at is in the future" },
        }));
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: mockFetch,
            ...NO_WAIT,
        });
        await expect(
            c.sendEvent({
                eventType: "tool.failed",
                correlationId: "job-1",
                source: "my-app",
                externalId: "run-1",
            }),
        ).rejects.toBeInstanceOf(RescontreAPIError);
        expect(calls.length).toBe(1);
    });

    it("gives up after exhausting the backoff schedule", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch(() => ({
            status: 503,
            body: { error: "unavailable" },
        }));
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: mockFetch,
            ...NO_WAIT,
        });
        await expect(
            c.sendEvent({
                eventType: "tool.delivered",
                correlationId: "job-1",
                source: "my-app",
                externalId: "run-1",
            }),
        ).rejects.toBeInstanceOf(RescontreAPIError);
        expect(calls.length).toBe(4); // 1 attempt + 3 retries
    });

    it("fails fast locally on invalid arguments without any request", async () => {
        const fetchSpy = vi.fn();
        const c = new Client("http://test", {
            apiKey: API_KEY,
            fetch: fetchSpy as unknown as typeof fetch,
        });

        await expect(
            c.sendEvent({
                eventType: "payment.exploded" as never,
                correlationId: "j",
                source: "s",
                externalId: "e",
            }),
        ).rejects.toBeInstanceOf(RescontreError);
        await expect(
            c.sendEvent({
                eventType: "tool.delivered",
                correlationId: "j",
                source: "rail:stripe",
                externalId: "e",
            }),
        ).rejects.toThrow(/reserved/);
        await expect(
            c.sendEvent({
                eventType: "payment.succeeded",
                correlationId: "j",
                source: "my-app",
                externalId: "e",
            }),
        ).rejects.toThrow(/amount/);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe("issue inbox and receipts", () => {
    it("hits the expected paths with query params and the API key", async () => {
        const { fetch: mockFetch, calls } = makeMockFetch((req) => {
            const path = new URL(req.url).pathname;
            if (path === "/issues") {
                return { body: { issues: [], count: 0 } };
            }
            if (path === "/receipts") {
                return { body: { receipts: [] } };
            }
            return {
                body: {
                    correlation_id: "job-1",
                    timeline: [],
                    events: [],
                    commitments: [],
                    settlements: [],
                    issues: [],
                },
            };
        });
        const c = new Client("http://test", { apiKey: API_KEY, fetch: mockFetch });

        await c.listIssues({ status: "all", provider: "server-1" });
        await c.searchReceipts({ provider: "server-1", since: 100, until: 200 });
        await c.getReceipt("job-1");

        const urls = calls.map((call) => new URL(call.url));
        expect(urls.map((u) => u.pathname)).toEqual([
            "/issues",
            "/receipts",
            "/receipts/job-1",
        ]);
        expect(urls[0]!.searchParams.get("status")).toBe("all");
        expect(urls[0]!.searchParams.get("provider")).toBe("server-1");
        expect(urls[1]!.searchParams.get("since")).toBe("100");
        expect(urls[1]!.searchParams.get("until")).toBe("200");
        expect(calls.every((call) => call.headers["x-api-key"] === API_KEY)).toBe(true);
    });
});
