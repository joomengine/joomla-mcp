import { randomUUID } from 'node:crypto';
import {
  createServer as createNodeHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  StreamableHTTPServerTransport,
  type EventStore,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { AccessController, AccessLimitError, type AccessLimits, type AccessLease } from './access-limits.js';
import { type AuditSink, noopAuditSink, safeAudit } from './audit.js';
import {
  AuthorizationError,
  authorizeBearerJwt,
  type AuthorizedPrincipal,
  type JwtAuthorizationPolicy,
  type JwtCryptographicVerifier,
} from './auth.js';
import { RequestPolicyError, StrictRequestPolicy, type RequestBoundaryPolicy } from './request-policy.js';

const DEFAULT_LIMITS: RemoteHttpLimits = {
  maxBodyBytes: 1_048_576,
  maxSessions: 1_000,
  sessionIdleTtlMs: 15 * 60_000,
  sessionMaxLifetimeMs: 8 * 60 * 60_000,
  bodyTimeoutMs: 15_000,
  maxConcurrentRequests: 100,
  maxConcurrentRequestsPerPrincipal: 8,
  requestsPerMinutePerPrincipal: 120,
  burstPerPrincipal: 20,
  maxTrackedPrincipals: 10_000,
};

export interface RemoteHttpLimits extends AccessLimits {
  readonly maxBodyBytes: number;
  readonly maxSessions: number;
  readonly sessionIdleTtlMs: number;
  readonly sessionMaxLifetimeMs: number;
  readonly bodyTimeoutMs: number;
}

export interface RemoteHttpGatewayOptions {
  readonly createMcpServer: () => McpServer | Promise<McpServer>;
  readonly jwtVerifier: JwtCryptographicVerifier;
  readonly authorization: JwtAuthorizationPolicy;
  readonly requestPolicy: RequestBoundaryPolicy;
  readonly limits?: Partial<RemoteHttpLimits>;
  readonly audit?: AuditSink;
  readonly mcpPath?: string;
  readonly healthPath?: string;
  readonly readinessPath?: string;
  readonly readinessCheck?: () => Promise<void>;
  readonly shutdownGraceMs?: number;
  readonly resourceMetadataUrl?: string;
  readonly enableJsonResponse?: boolean;
  readonly eventStoreFactory?: () => EventStore;
  readonly sseRetryIntervalMs?: number;
  readonly now?: () => number;
}

export interface RemoteHttpServerController {
  readonly server: NodeHttpServer;
  readonly gateway: RemoteHttpGateway;
  close(): Promise<void>;
}

interface SessionEntry {
  readonly id: string;
  readonly subject: string;
  readonly clientId: string;
  readonly createdAtMs: number;
  lastSeenAtMs: number;
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

class HttpGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'HttpGatewayError';
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export class RemoteHttpGateway {
  readonly #options: RemoteHttpGatewayOptions;
  readonly #limits: RemoteHttpLimits;
  readonly #requestPolicy: StrictRequestPolicy;
  readonly #access: AccessController;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #audit: AuditSink;
  readonly #mcpPath: string;
  readonly #healthPath: string;
  readonly #readinessPath: string;
  readonly #metadataPath: string | undefined;
  readonly #now: () => number;
  readonly #sweepTimer: NodeJS.Timeout;
  #closed = false;
  #initializingSessions = 0;

  constructor(options: RemoteHttpGatewayOptions) {
    this.#options = options;
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...options.limits });
    this.#requestPolicy = new StrictRequestPolicy(options.requestPolicy);
    this.#access = new AccessController({
      maxConcurrentRequests: this.#limits.maxConcurrentRequests,
      maxConcurrentRequestsPerPrincipal: this.#limits.maxConcurrentRequestsPerPrincipal,
      requestsPerMinutePerPrincipal: this.#limits.requestsPerMinutePerPrincipal,
      burstPerPrincipal: this.#limits.burstPerPrincipal,
      maxTrackedPrincipals: this.#limits.maxTrackedPrincipals,
    });
    this.#audit = options.audit ?? noopAuditSink;
    this.#mcpPath = validatePath(options.mcpPath ?? '/mcp', 'mcpPath');
    this.#healthPath = validatePath(options.healthPath ?? '/healthz', 'healthPath');
    this.#readinessPath = validatePath(options.readinessPath ?? '/readyz', 'readinessPath');
    if (new Set([this.#mcpPath, this.#healthPath, this.#readinessPath]).size !== 3) {
      throw new TypeError('mcpPath, healthPath, and readinessPath must differ.');
    }
    if (options.resourceMetadataUrl !== undefined) {
      validateHttpsUrl(options.resourceMetadataUrl, 'resourceMetadataUrl');
      validateHttpsUrl(options.authorization.issuer, 'authorization.issuer');
      validateHttpsUrl(options.authorization.audience, 'authorization.audience');
    }
    this.#metadataPath =
      options.resourceMetadataUrl === undefined ? undefined : new URL(options.resourceMetadataUrl).pathname;
    if (
      this.#metadataPath === this.#mcpPath ||
      this.#metadataPath === this.#healthPath ||
      this.#metadataPath === this.#readinessPath
    ) {
      throw new TypeError('resourceMetadataUrl path must differ from mcpPath, healthPath, and readinessPath.');
    }
    if (
      options.sseRetryIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.sseRetryIntervalMs) || options.sseRetryIntervalMs < 1_000 || options.sseRetryIntervalMs > 60_000)
    ) {
      throw new TypeError('sseRetryIntervalMs must be an integer between 1000 and 60000.');
    }
    this.#now = options.now ?? Date.now;
    const sweepIntervalMs = Math.max(1_000, Math.min(60_000, Math.floor(this.#limits.sessionIdleTtlMs / 2)));
    this.#sweepTimer = setInterval(() => void this.#expireSessions(), sweepIntervalMs);
    this.#sweepTimer.unref();
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startedAtMs = this.#now();
    const requestId = randomUUID();
    const method = req.method ?? 'UNKNOWN';
    const path = requestPath(req.url);
    let principal: AuthorizedPrincipal | undefined;
    let lease: AccessLease | undefined;
    let auditReason: string | undefined;

    secureResponseHeaders(res, requestId);

    try {
      if (this.#closed) {
        throw new HttpGatewayError(503, 'server_closing', 'The server is closing.', 1);
      }
      this.#requestPolicy.assert(req);

      if (path === this.#healthPath) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new HttpGatewayError(405, 'method_not_allowed', 'Health accepts only GET and HEAD.');
        }
        res.setHeader('Allow', 'GET, HEAD');
        writeJson(res, 200, { status: 'ok' }, method === 'HEAD');
        return;
      }

      if (path === this.#readinessPath) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new HttpGatewayError(405, 'method_not_allowed', 'Readiness accepts only GET and HEAD.');
        }
        res.setHeader('Allow', 'GET, HEAD');
        try {
          await (this.#options.readinessCheck?.() ?? Promise.resolve());
        } catch {
          throw new HttpGatewayError(503, 'not_ready', 'A required dependency is unavailable.', 1);
        }
        writeJson(res, 200, { status: 'ready' }, method === 'HEAD');
        return;
      }

      if (this.#metadataPath !== undefined && path === this.#metadataPath && !hasQueryOrFragment(req.url)) {
        if (method !== 'GET' && method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD');
          throw new HttpGatewayError(405, 'method_not_allowed', 'Protected resource metadata accepts only GET and HEAD.');
        }
        writeJson(
          res,
          200,
          {
            resource: this.#options.authorization.audience,
            authorization_servers: [this.#options.authorization.issuer],
            scopes_supported: [...this.#options.authorization.requiredScopes],
            bearer_methods_supported: ['header'],
          },
          method === 'HEAD',
        );
        return;
      }

      if (path !== this.#mcpPath || hasQueryOrFragment(req.url)) {
        throw new HttpGatewayError(404, 'not_found', 'Route not found.');
      }
      if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
        res.setHeader('Allow', 'GET, POST, DELETE');
        throw new HttpGatewayError(405, 'method_not_allowed', 'Unsupported MCP transport method.');
      }

      assertSingleAuthorization(req.rawHeaders);
      principal = await authorizeBearerJwt(
        req.headers.authorization,
        this.#options.jwtVerifier,
        this.#options.authorization,
        Math.floor(this.#now() / 1_000),
      );
      lease = this.#access.acquire(principal.subject, this.#now());
      await this.#expireSessions();

      const body = method === 'POST' ? await readBoundedJsonBody(req, this.#limits) : assertNoRequestBody(req);
      await this.#dispatchMcp(req, res, body, principal, requestId, startedAtMs);
    } catch (error) {
      const normalized = normalizeError(error, this.#options.resourceMetadataUrl);
      auditReason = normalized.code;
      if (normalized.wwwAuthenticate !== undefined) {
        res.setHeader('WWW-Authenticate', normalized.wwwAuthenticate);
      }
      if (normalized.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(normalized.retryAfterSeconds));
      }
      writeJson(res, normalized.status, { error: normalized.code, requestId });
    } finally {
      lease?.release();
      const status = res.statusCode;
      const requestedSessionId = sessionIdFromRequest(req);
      await safeAudit(this.#audit, {
        type: auditReason === undefined && status < 400 ? 'request_completed' : 'request_rejected',
        timestamp: new Date(this.#now()).toISOString(),
        requestId,
        method,
        path,
        status,
        durationMs: Math.max(0, this.#now() - startedAtMs),
        ...(principal === undefined ? {} : { subject: principal.subject }),
        ...(requestedSessionId === undefined ? {} : { sessionId: requestedSessionId }),
        ...(auditReason === undefined && status < 400 ? {} : { reason: auditReason ?? 'transport_rejected' }),
      });
    }
  }

  async close(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([...this.#sessions.keys()].map(async (sessionId) => this.#closeSession(sessionId, 'shutdown')));
  }

  beginShutdown(): void {
    if (!this.#closed) {
      this.#closed = true;
      clearInterval(this.#sweepTimer);
    }
  }

  async #dispatchMcp(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    principal: AuthorizedPrincipal,
    requestId: string,
    startedAtMs: number,
  ): Promise<void> {
    const requestedSessionId = validatedSessionId(req);
    if (requestedSessionId !== undefined) {
      const session = this.#sessions.get(requestedSessionId);
      if (session === undefined) {
        throw new HttpGatewayError(404, 'session_not_found', 'MCP session not found.');
      }
      if (session.subject !== principal.subject || session.clientId !== principal.clientId) {
        throw new HttpGatewayError(403, 'session_owner_mismatch', 'MCP session belongs to another principal.');
      }
      session.lastSeenAtMs = this.#now();
      attachAuth(req, principal.authInfo);
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      throw new HttpGatewayError(400, 'session_required', 'A valid session ID is required after initialization.');
    }
    if (this.#sessions.size + this.#initializingSessions >= this.#limits.maxSessions) {
      throw new HttpGatewayError(503, 'session_capacity_exceeded', 'MCP session capacity is exhausted.', 5);
    }

    this.#initializingSessions += 1;
    try {
      const mcpServer = await this.#options.createMcpServer();
      let sessionEntry: SessionEntry | undefined;
      const eventStore = this.#options.eventStoreFactory?.();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: this.#options.enableJsonResponse ?? false,
        ...(eventStore === undefined ? {} : { eventStore }),
        ...(this.#options.sseRetryIntervalMs === undefined ? {} : { retryInterval: this.#options.sseRetryIntervalMs }),
        onsessioninitialized: async (sessionId) => {
          if (this.#sessions.has(sessionId)) {
            throw new Error('A duplicate MCP session ID was generated.');
          }
          sessionEntry = {
            id: sessionId,
            subject: principal.subject,
            clientId: principal.clientId,
            createdAtMs: this.#now(),
            lastSeenAtMs: this.#now(),
            transport,
            server: mcpServer,
          };
          this.#sessions.set(sessionId, sessionEntry);
          await safeAudit(this.#audit, {
            type: 'session_opened',
            timestamp: new Date(this.#now()).toISOString(),
            requestId,
            method: req.method ?? 'POST',
            path: this.#mcpPath,
            status: 200,
            durationMs: Math.max(0, this.#now() - startedAtMs),
            subject: principal.subject,
            sessionId,
          });
        },
        onsessionclosed: async (sessionId) => this.#closeSession(sessionId, 'client_delete'),
      });

      try {
        // SDK v1's declaration conflicts with exactOptionalPropertyTypes even though
        // StreamableHTTPServerTransport implements Transport at runtime.
        await mcpServer.connect(transport as unknown as Transport);
        attachAuth(req, principal.authInfo);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (sessionEntry !== undefined) {
          this.#sessions.delete(sessionEntry.id);
        }
        await mcpServer.close().catch(() => undefined);
        throw error;
      }

      if (transport.sessionId === undefined) {
        await mcpServer.close().catch(() => undefined);
      }
    } finally {
      this.#initializingSessions -= 1;
    }
  }

  async #expireSessions(): Promise<void> {
    const now = this.#now();
    const expired = [...this.#sessions.values()]
      .filter(
        (session) =>
          now - session.lastSeenAtMs >= this.#limits.sessionIdleTtlMs ||
          now - session.createdAtMs >= this.#limits.sessionMaxLifetimeMs,
      )
      .map((session) => session.id);
    await Promise.allSettled(expired.map(async (sessionId) => this.#closeSession(sessionId, 'expired')));
  }

  async #closeSession(sessionId: string, reason: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      return;
    }
    this.#sessions.delete(sessionId);
    await session.server.close().catch(() => undefined);
    await safeAudit(this.#audit, {
      type: 'session_closed',
      timestamp: new Date(this.#now()).toISOString(),
      requestId: randomUUID(),
      method: 'INTERNAL',
      path: this.#mcpPath,
      status: 200,
      durationMs: 0,
      subject: session.subject,
      sessionId,
      reason,
    });
  }
}

export function createRemoteHttpServer(options: RemoteHttpGatewayOptions): RemoteHttpServerController {
  const gateway = new RemoteHttpGateway(options);
  const maxHeaderBytes = options.requestPolicy.maxHeaderBytes ?? 16_384;
  const shutdownGraceMs = boundedInteger(options.shutdownGraceMs ?? 30_000, 1_000, 120_000, 'shutdownGraceMs');
  const server = createNodeHttpServer(
    {
      maxHeaderSize: maxHeaderBytes,
      requestTimeout: 0,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
      connectionsCheckingInterval: 1_000,
    },
    (req, res) => void gateway.handleRequest(req, res),
  );
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1_000;

  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    gateway.beginShutdown();
    if (!server.listening) {
      await gateway.close();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const forceTimer = setTimeout(() => server.closeAllConnections(), shutdownGraceMs);
      server.close((error) => {
        clearTimeout(forceTimer);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
      server.closeIdleConnections();
    });
    await gateway.close();
  };

  return {
    server,
    gateway,
    close: async () => (closePromise ??= close()),
  };
}

function validateLimits(limits: RemoteHttpLimits): RemoteHttpLimits {
  const bounded: Readonly<Record<keyof RemoteHttpLimits, readonly [number, number]>> = {
    maxBodyBytes: [1_024, 10_485_760],
    maxSessions: [1, 100_000],
    sessionIdleTtlMs: [10_000, 86_400_000],
    sessionMaxLifetimeMs: [10_000, 604_800_000],
    bodyTimeoutMs: [1_000, 120_000],
    maxConcurrentRequests: [1, 100_000],
    maxConcurrentRequestsPerPrincipal: [1, 10_000],
    requestsPerMinutePerPrincipal: [1, 1_000_000],
    burstPerPrincipal: [1, 100_000],
    maxTrackedPrincipals: [1, 1_000_000],
  };
  for (const [name, range] of Object.entries(bounded) as [keyof RemoteHttpLimits, readonly [number, number]][]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < range[0] || value > range[1]) {
      throw new TypeError(`${name} must be an integer between ${range[0]} and ${range[1]}.`);
    }
  }
  if (limits.sessionMaxLifetimeMs < limits.sessionIdleTtlMs) {
    throw new TypeError('sessionMaxLifetimeMs may not be shorter than sessionIdleTtlMs.');
  }
  return limits;
}

async function readBoundedJsonBody(req: IncomingMessage, limits: RemoteHttpLimits): Promise<unknown> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new HttpGatewayError(415, 'content_type_unsupported', 'POST requires application/json.');
  }
  const contentEncoding = req.headers['content-encoding'];
  if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity') {
    throw new HttpGatewayError(415, 'content_encoding_unsupported', 'Compressed request bodies are not accepted.');
  }
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength)) {
      throw new HttpGatewayError(400, 'content_length_invalid', 'Content-Length is invalid.');
    }
    if (Number(declaredLength) > limits.maxBodyBytes) {
      throw new HttpGatewayError(413, 'body_too_large', 'Request body exceeds the configured limit.');
    }
  }

  return await new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new HttpGatewayError(408, 'body_timeout', 'Request body timed out.')), limits.bodyTimeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
      req.setTimeout(0);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limits.maxBodyBytes) {
        fail(new HttpGatewayError(413, 'body_too_large', 'Request body exceeds the configured limit.'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown);
      } catch {
        reject(new HttpGatewayError(400, 'json_invalid', 'Request body is not valid JSON.'));
      }
    };
    const onAborted = (): void => fail(new HttpGatewayError(400, 'request_aborted', 'Request was aborted.'));
    const onError = (): void => fail(new HttpGatewayError(400, 'request_stream_error', 'Request body could not be read.'));

    req.setTimeout(limits.bodyTimeoutMs, () => fail(new HttpGatewayError(408, 'body_timeout', 'Request body timed out.')));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}

function assertNoRequestBody(req: IncomingMessage): undefined {
  if (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? '0') > 0) {
    req.resume();
    throw new HttpGatewayError(400, 'body_not_allowed', 'This method does not accept a request body.');
  }
  return undefined;
}

function validatedSessionId(req: IncomingMessage): string | undefined {
  const values = rawHeaderValues(req.rawHeaders, 'mcp-session-id');
  if (values.length > 1 || Array.isArray(req.headers['mcp-session-id'])) {
    throw new HttpGatewayError(400, 'session_id_duplicate', 'Only one MCP-Session-Id is accepted.');
  }
  const value = req.headers['mcp-session-id'];
  if (value === undefined) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new HttpGatewayError(400, 'session_id_invalid', 'MCP-Session-Id is malformed.');
  }
  return value;
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined;
}

function attachAuth(req: IncomingMessage, auth: AuthInfo): void {
  (req as IncomingMessage & { auth?: AuthInfo }).auth = auth;
}

function assertSingleAuthorization(rawHeaders: readonly string[]): void {
  if (rawHeaderValues(rawHeaders, 'authorization').length > 1) {
    throw new AuthorizationError(401, 'authorization_malformed', 'Only one Authorization header is accepted.');
  }
}

function rawHeaderValues(rawHeaders: readonly string[], name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const value = rawHeaders[index + 1];
    if (rawHeaders[index]?.toLowerCase() === name && value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

function normalizeError(error: unknown, resourceMetadataUrl?: string): {
  status: number;
  code: string;
  retryAfterSeconds?: number;
  wwwAuthenticate?: string;
} {
  if (error instanceof AuthorizationError) {
    return {
      status: error.status,
      code: error.code,
      wwwAuthenticate: error.wwwAuthenticate(resourceMetadataUrl),
    };
  }
  if (error instanceof RequestPolicyError) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof AccessLimitError || error instanceof HttpGatewayError) {
    return {
      status: error.status,
      code: error.code,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }
  return { status: 500, code: 'internal_error' };
}

function secureResponseHeaders(res: ServerResponse, requestId: string): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

function writeJson(res: ServerResponse, status: number, body: unknown, headOnly = false): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const encoded = Buffer.from(JSON.stringify(body));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(encoded.length));
  res.end(headOnly ? undefined : encoded);
}

function requestPath(value: string | undefined): string {
  if (value === undefined || !value.startsWith('/')) {
    return '/';
  }
  return value.split(/[?#]/u, 1)[0] ?? '/';
}

function hasQueryOrFragment(value: string | undefined): boolean {
  return value?.includes('?') === true || value?.includes('#') === true;
}

function validatePath(value: string, name: string): string {
  if (!/^\/[A-Za-z0-9/_-]*$/u.test(value) || value.includes('//')) {
    throw new TypeError(`${name} must be an absolute path without a query or fragment.`);
  }
  return value;
}

function validateHttpsUrl(value: string, name: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a credential-free HTTPS URL.`);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
