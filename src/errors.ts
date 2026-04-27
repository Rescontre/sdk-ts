export class RescontreError extends Error { 
    
}

export class RescontreAPIError extends RescontreError { 

    status_code: number; 
    response_body: unknown; 
    constructor(message: string, status_code: number, response_body: unknown) {
       super(message);

        this.status_code = status_code;
        this.response_body = response_body; 
    }

    toString(): string {
        return `[${this.status_code}] ${this.message}`;
    }
}