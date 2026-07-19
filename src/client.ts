import {
    AuthenticationError,
    RescontreAPIError,
    RescontreConfigurationError,
    RescontreError,
} from "./errors";
import {
    AMOUNT_REQUIRED_EVENT_TYPES,
    EVENT_TYPES,
    RESERVED_SOURCE_PREFIXES,
} from "./models";
import type {
    BilateralSettlementResult,
    Direction,
    IngestEventResult,
    OpsEventType,
    SettleResponse,
    VerifyResponse,
} from "./models";

const DEFAULT_TIMEOUT_MS = 10_000;
export const API_KEY_ENV = "RESCONTRE_API_KEY";
export const API_KEY_HEADER = "X-API-Key";

// sendEvent retry schedule (ms between attempts). Retrying is safe by
// design: the server dedups on (source, external_id, event_type), so a
// retried send that actually landed the first time returns
// duplicate=true instead of double-recording.
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [500, 1000, 2000];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export interface ClientOptions {
    apiKey?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    /** Override the sendEvent retry schedule (ms between attempts).
     * Its length is the number of retries; [] disables retrying. */
    retryBackoffMs?: readonly number[];
}

export interface SendEventParams {
    eventType: OpsEventType;
    /** Ties events into one receipt timeline. */
    correlationId: string;
    /** Your system's name. `rail:` / `webhook:` prefixes are reserved. */
    source: string;
    /** Upstream id (Stripe intent, tx hash, your job id, ...). Reuse it
     * on resends — it is the idempotency handle. */
    externalId: string;
    /** Unix seconds the event happened upstream; defaults server-side
     * to ingest time. */
    occurredAt?: number;
    agentId?: string;
    providerId?: string;
    toolName?: string;
    /** Microdollars ($1 === 1_000_000). Required (> 0) for
     * payment.succeeded / payment.refunded. */
    amount?: number;
    currency?: string;
    statusDetail?: string;
    /** Raw source payload; retained redacted, hashed pre-redaction. */
    payload?: unknown;
}

export interface ListIssuesParams {
    /** Defaults to "open" server-side; pass "all" for every status. */
    status?: string;
    provider?: string;
    limit?: number;
}

export interface SearchReceiptsParams {
    correlationId?: string;
    agent?: string;
    provider?: string;
    tool?: string;
    externalId?: string;
    txHash?: string;
    source?: string;
    eventType?: OpsEventType;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
}

export interface CreateAgreementOptions {
    creditLimit?: number;
    settlementFrequency?: number;
}

export interface SettleOptions {
    direction?: Direction;
}

function toQueryString(
    params: Record<string, string | number | undefined>,
): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            search.set(key, String(value));
        }
    }
    const encoded = search.toString();
    return encoded ? `?${encoded}` : "";
}

export class Client {
    readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly timeoutMs: number;
    private readonly fetchImpl: typeof fetch;
    private readonly retryBackoffMs: readonly number[];

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
        this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
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

    // ── Agent payment ops: events / receipts / issues ────────────────

    /**
     * Record one activity event (POST /events), with retries.
     *
     * Transient failures (network errors, timeouts, 429/5xx) are
     * retried with backoff. This is safe: the server dedups on
     * (source, external_id, event_type), so a send that landed but
     * whose response was lost returns `duplicate: true` on retry.
     * 4xx responses are never retried — they mean the event itself
     * is invalid.
     */
    async sendEvent(params: SendEventParams): Promise<IngestEventResult> {
        if (!(EVENT_TYPES as readonly string[]).includes(params.eventType)) {
            throw new RescontreError(
                `unknown eventType ${JSON.stringify(params.eventType)}; ` +
                    `expected one of: ${EVENT_TYPES.join(", ")}`,
            );
        }
        for (const prefix of RESERVED_SOURCE_PREFIXES) {
            if (params.source.startsWith(prefix)) {
                throw new RescontreError(
                    `source prefix "${prefix}" is reserved for rail-verified ` +
                        'ingestion; pick a source name for your own system, e.g. "my-app"',
                );
            }
        }
        if (AMOUNT_REQUIRED_EVENT_TYPES.has(params.eventType) && !params.amount) {
            throw new RescontreError(
                `amount (microdollars, > 0) is required for ${params.eventType}`,
            );
        }

        const body: Record<string, unknown> = {
            event_type: params.eventType,
            correlation_id: params.correlationId,
            source: params.source,
            external_id: params.externalId,
        };
        const optional: Record<string, unknown> = {
            occurred_at: params.occurredAt,
            agent_id: params.agentId,
            provider_id: params.providerId,
            tool_name: params.toolName,
            amount: params.amount,
            currency: params.currency,
            status_detail: params.statusDetail,
            payload: params.payload,
        };
        for (const [key, value] of Object.entries(optional)) {
            if (value !== undefined) {
                body[key] = value;
            }
        }

        const attempts = this.retryBackoffMs.length + 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const isLast = attempt === attempts - 1;
            try {
                return (await this.request(
                    "POST",
                    "/events",
                    body,
                    true,
                )) as IngestEventResult;
            } catch (e) {
                if (e instanceof AuthenticationError) {
                    throw e;
                }
                if (e instanceof RescontreAPIError) {
                    if (!RETRYABLE_STATUS_CODES.has(e.status_code) || isLast) {
                        throw e;
                    }
                } else if (isLast) {
                    // Network / timeout errors surface as TypeError or
                    // AbortError from fetch — retryable until the last try.
                    throw e;
                }
            }
            await new Promise((resolve) =>
                setTimeout(resolve, this.retryBackoffMs[attempt]),
            );
        }
        throw new Error("unreachable: retry loop exits by return or throw");
    }

    /** Issue inbox (GET /issues). Open issues by default. */
    async listIssues(params: ListIssuesParams = {}): Promise<Record<string, unknown>> {
        return (await this.request(
            "GET",
            `/issues${toQueryString({
                status: params.status,
                provider: params.provider,
                limit: params.limit,
            })}`,
            undefined,
            true,
        )) as Record<string, unknown>;
    }

    /**
     * Search receipt timelines (GET /receipts). At least one filter is
     * required; filters are AND-combined.
     */
    async searchReceipts(
        params: SearchReceiptsParams,
    ): Promise<Record<string, unknown>> {
        return (await this.request(
            "GET",
            `/receipts${toQueryString({
                correlation_id: params.correlationId,
                agent: params.agent,
                provider: params.provider,
                tool: params.tool,
                external_id: params.externalId,
                tx_hash: params.txHash,
                source: params.source,
                event_type: params.eventType,
                since: params.since,
                until: params.until,
                limit: params.limit,
                offset: params.offset,
            })}`,
            undefined,
            true,
        )) as Record<string, unknown>;
    }

    /**
     * Full receipt timeline for one correlation_id (GET /receipts/{id}):
     * events, commitments, settlement proofs, open issues, and evidence
     * hashes, merged and ordered.
     */
    async getReceipt(correlationId: string): Promise<Record<string, unknown>> {
        return (await this.request(
            "GET",
            `/receipts/${encodeURIComponent(correlationId)}`,
            undefined,
            true,
        )) as Record<string, unknown>;
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
