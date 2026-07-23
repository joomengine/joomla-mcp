export interface AccessLimits {
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentRequestsPerPrincipal: number;
  readonly requestsPerMinutePerPrincipal: number;
  readonly burstPerPrincipal: number;
  readonly maxTrackedPrincipals: number;
}

export type AccessLimitFailureCode =
  | 'server_concurrency_exceeded'
  | 'principal_concurrency_exceeded'
  | 'principal_capacity_exceeded'
  | 'rate_exceeded';

export class AccessLimitError extends Error {
  readonly status: 429 | 503;
  readonly code: AccessLimitFailureCode;
  readonly retryAfterSeconds: number;

  constructor(status: 429 | 503, code: AccessLimitFailureCode, retryAfterSeconds: number) {
    super(code);
    this.name = 'AccessLimitError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface PrincipalState {
  active: number;
  tokens: number;
  updatedAtMs: number;
}

export interface AccessLease {
  release(): void;
}

export class AccessController {
  readonly #limits: AccessLimits;
  readonly #states = new Map<string, PrincipalState>();
  #active = 0;

  constructor(limits: AccessLimits) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
        throw new TypeError(`${name} must be a positive bounded integer.`);
      }
    }
    if (limits.maxConcurrentRequestsPerPrincipal > limits.maxConcurrentRequests) {
      throw new TypeError('Per-principal concurrency may not exceed global concurrency.');
    }
    this.#limits = limits;
  }

  acquire(principal: string, nowMs = Date.now()): AccessLease {
    const state = this.#state(principal, nowMs);

    if (this.#active >= this.#limits.maxConcurrentRequests) {
      throw new AccessLimitError(503, 'server_concurrency_exceeded', 1);
    }
    if (state.active >= this.#limits.maxConcurrentRequestsPerPrincipal) {
      throw new AccessLimitError(429, 'principal_concurrency_exceeded', 1);
    }

    this.#refill(state, nowMs);
    if (state.tokens < 1) {
      const refillPerMs = this.#limits.requestsPerMinutePerPrincipal / 60_000;
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - state.tokens) / refillPerMs / 1_000));
      throw new AccessLimitError(429, 'rate_exceeded', retryAfterSeconds);
    }

    state.tokens -= 1;
    state.active += 1;
    this.#active += 1;

    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        state.active -= 1;
        this.#active -= 1;
      },
    };
  }

  get activeRequests(): number {
    return this.#active;
  }

  #state(principal: string, nowMs: number): PrincipalState {
    const existing = this.#states.get(principal);
    if (existing !== undefined) {
      return existing;
    }
    this.#prune(nowMs);
    if (this.#states.size >= this.#limits.maxTrackedPrincipals) {
      throw new AccessLimitError(503, 'principal_capacity_exceeded', 60);
    }
    const created = { active: 0, tokens: this.#limits.burstPerPrincipal, updatedAtMs: nowMs };
    this.#states.set(principal, created);
    return created;
  }

  #refill(state: PrincipalState, nowMs: number): void {
    const elapsedMs = Math.max(0, nowMs - state.updatedAtMs);
    state.tokens = Math.min(
      this.#limits.burstPerPrincipal,
      state.tokens + (elapsedMs * this.#limits.requestsPerMinutePerPrincipal) / 60_000,
    );
    state.updatedAtMs = nowMs;
  }

  #prune(nowMs: number): void {
    for (const [principal, state] of this.#states) {
      if (state.active === 0 && nowMs - state.updatedAtMs >= 60_000) {
        this.#states.delete(principal);
      }
    }
  }
}
