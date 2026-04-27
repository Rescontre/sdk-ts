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