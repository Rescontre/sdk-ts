// Direction, Rail, CreditTier - String Enums 

export enum Direction { 
    AgentToServer = "AgentToServer",
    ServerToAgent = "ServerToAgent", 
}

export enum Rail { 
    X402 = "X402", 
    Stripe = "Stripe", 
    Crypto = "Crypto",
}

export enum CreditTier { 
    Minimal = "Minimal", 
    Basic = "Basic",
    Established = "Established", 
    Trusted = "Trusted",
}

// ── Agent payment ops (events / receipts / issues) ──────────────────

/**
 * Closed vocabulary accepted by POST /events. Mirrors the server's
 * OpsEventType enum; anything else is rejected with a 400.
 */
export const EVENT_TYPES = [
    "tool.requested",
    "tool.delivered",
    "tool.failed",
    "payment.initiated",
    "payment.succeeded",
    "payment.failed",
    "payment.refunded",
    "dispute.opened",
    "dispute.resolved",
] as const;

export type OpsEventType = (typeof EVENT_TYPES)[number];

/**
 * Event types that assert money actually moved and therefore require
 * an `amount` (in microdollars, > 0).
 */
export const AMOUNT_REQUIRED_EVENT_TYPES: ReadonlySet<string> = new Set([
    "payment.succeeded",
    "payment.refunded",
]);

/**
 * Source prefixes reserved for rail-verified ingestion on the server.
 * A customer event claiming one of these would be forging rail
 * evidence, so the server rejects them and the SDK fails fast locally.
 */
export const RESERVED_SOURCE_PREFIXES = ["rail:", "webhook:"] as const;

/**
 * Response of POST /events. `duplicate === true` means this
 * (source, external_id, event_type) was already recorded — an
 * idempotent success (e.g. a retried send), not an error.
 * `event_id` is only set for fresh inserts.
 */
export interface IngestEventResult {
    recorded: boolean;
    duplicate: boolean;
    event_id?: number | null;
    correlation_id: string;
}

export interface VerifyResponse {
    valid: boolean;
    reason?: string | null;
    remaining_credit?: number | null;
}

export interface SettleResponse { 
    settled: boolean;
    commitment_id?: string | null;
    net_position?: number | null;
    commitments_until_settlement?: number | null;
}

export interface BilateralSettlementResult { 
    agent_id: string;
    server_id: string;
    gross_volume: number;
    net_amount: number;
    commitments_netted: number;
    compression: number;
}