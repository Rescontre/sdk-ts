import {
    AuthenticationError,
    RescontreAPIError,
    RescontreConfigurationError,
} from "./errors";
import type {
    BilateralSettlementResult,
    Direction,
    SettleResponse,
    VerifyResponse,
} from "./models";

const DEFAULT_TIMEOUT_MS = 10_000;
export const API_KEY_ENV = "RESCONTRE_API_KEY";
export const API_KEY_HEADER = "X-API-Key";

export interface ClientOptions {
    apiKey?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
}

export interface CreateAgreementOptions {
    creditLimit?: number;
    settlementFrequency?: number;
}

export interface SettleOptions {
    direction?: Direction;
}

export class Client {
    readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;

    constructor(baseUrl: string = "http://localhost:3000", options: ClientOptions = {}) {
        const proc = (globalThis as {
            process?: { env?: Record<string, string | undefined> };
        }).process;
        const resolvedKey = options.apiKey ?? proc?.env?.[API_KEY_ENV];
        if (!resolvedKey) {
            throw new RescontreConfigurationError(
                "Rescontre API key is required. Pass apiKey to new Client(...) " +
                    `or set the ${API_KEY_ENV} environment variable. ` +
                    "Mint a key via POST /admin/keys with X-Internal-Secret.",
            );
        }
        this.apiKey = resolvedKey;
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchImpl = options.fetch ?? fetch;
    }

    private async request(
        method: string,
        path: string,
        body?: unknown,
        authenticated: boolean = false,
    ): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
            const headers: Record<string, string> = {};
            if (body !== undefined) {
                headers["Content-Type"] = "application/json";
            }
            if (authenticated) {
                headers[API_KEY_HEADER] = this.apiKey;
            }
            const init: RequestInit = { method, signal: controller.signal };
            if (Object.keys(headers).length > 0) {
                init.headers = headers;
            }
            if (body !== undefined) {
                init.body = JSON.stringify(body);
            }
            response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        let data: unknown = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = text;
            }
        }

        if (!response.ok) {
            let message = response.statusText;
            if (data && typeof data === "object") {
                const obj = data as Record<string, unknown>;
                if (typeof obj["error"] === "string") {
                    message = obj["error"];
                } else if (typeof obj["message"] === "string") {
                    message = obj["message"];
                } else if (text) {
                    message = text;
                }
            } else if (typeof data === "string" && data) {
                message = data;
            }
            if (authenticated && response.status === 401) {
                throw new AuthenticationError(
                    `Rescontre rejected the API key — check ${API_KEY_ENV} or ` +
                        "pass apiKey to the Client. " +
                        "Mint a key via POST /admin/keys with X-Internal-Secret.",
                    response.status,
                    data,
                );
            }
            throw new RescontreAPIError(message, response.status, data);
        }

        if (response.status === 204 || !text) {
            return null;
        }
        return data;
    }

    async health(): Promise<Record<string, unknown>> {
        return (await this.request("GET", "/health")) as Record<string, unknown>;
    }

    async registerAgent(
        agentId: string,
        walletAddress: string,
    ): Promise<Record<string, unknown>> {
        return (await this.request("POST", "/agents", {
            id: agentId,
            wallet_address: walletAddress,
        })) as Record<string, unknown>;
    }

    async registerServer(
        serverId: string,
        walletAddress: string,
        endpoints: string[],
    ): Promise<Record<string, unknown>> {
        return (await this.request("POST", "/servers", {
            id: serverId,
            wallet_address: walletAddress,
            endpoints,
        })) as Record<string, unknown>;
    }

    async createAgreement(
        agentId: string,
        serverId: string,
        options: CreateAgreementOptions = {},
    ): Promise<Record<string, unknown>> {
        return (await this.request("POST", "/agreements", {
            agent_id: agentId,
            server_id: serverId,
            credit_limit: options.creditLimit ?? null,
            settlement_frequency: options.settlementFrequency ?? null,
        })) as Record<string, unknown>;
    }

    async verify(
        agentId: string,
        serverId: string,
        amount: number,
        nonce: string,
    ): Promise<VerifyResponse> {
        return (await this.request(
            "POST",
            "/internal/verify",
            {
                agent_id: agentId,
                server_id: serverId,
                amount,
                nonce,
            },
            true,
        )) as VerifyResponse;
    }

    async settle(
        agentId: string,
        serverId: string,
        amount: number,
        nonce: string,
        description: string,
        options: SettleOptions = {},
    ): Promise<SettleResponse> {
        return (await this.request(
            "POST",
            "/internal/settle",
            {
                agent_id: agentId,
                server_id: serverId,
                amount,
                nonce,
                description,
                direction: options.direction ?? null,
            },
            true,
        )) as SettleResponse;
    }

    async bilateralSettlement(
        agentId: string,
        serverId: string,
    ): Promise<BilateralSettlementResult> {
        return (await this.request("POST", "/settlement", {
            agent_id: agentId,
            server_id: serverId,
        })) as BilateralSettlementResult;
    }
}
