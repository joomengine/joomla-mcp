import { request, type IncomingHttpHeaders } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type HttpAuditEvent } from '../src/http/audit.js';
import { createRemoteHttpServer, type RemoteHttpServerController } from '../src/http/remote-http.js';
import type { Configuration } from '../src/config/schema.js';
import { createServer as createJoomlaServer } from '../src/mcp/create-server.js';

const nowSeconds = Math.floor(Date.now() / 1_000);
const acceptedToken = 'accepted.payload.signature';
const otherToken = 'other.payload.signature';

describe('production remote Streamable HTTP gateway', () => {
  let controller: RemoteHttpServerController | undefined;

  afterEach(async () => {
    await controller?.close();
    controller = undefined;
  });

  it('serves health, rejects an untrusted Origin, initializes a bounded stateful session, and binds it to its principal', async () => {
    const audit: HttpAuditEvent[] = [];
    controller = createRemoteHttpServer({
      createMcpServer: () => new McpServer({ name: 'http-test', version: '1.0.0' }),
      jwtVerifier: {
        verify: async (token) => ({
          iss: 'https://identity.example.test',
          aud: 'https://mcp.example.test',
          sub: token === acceptedToken ? 'owner' : 'other',
          client_id: token === acceptedToken ? 'owner-client' : 'other-client',
          exp: nowSeconds + 600,
          scope: 'mcp:access',
        }),
      },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: {
        allowedHosts: ['mcp.internal.test'],
        allowedOrigins: ['https://client.example.test'],
      },
      audit: { emit: (event) => void audit.push(event) },
      enableJsonResponse: true,
    });
    await listen(controller);

    const health = await send(controller, { method: 'GET', path: '/healthz' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });

    const readiness = await send(controller, { method: 'GET', path: '/readyz' });
    expect(readiness.status).toBe(200);
    expect(JSON.parse(readiness.body)).toEqual({ status: 'ready' });

    const rejectedOrigin = await send(controller, {
      method: 'POST',
      path: '/mcp',
      origin: 'https://attacker.example.test',
      token: acceptedToken,
      body: initializeBody(),
    });
    expect(rejectedOrigin.status).toBe(403);
    expect(JSON.parse(rejectedOrigin.body).error).toBe('origin_forbidden');

    const initialized = await send(controller, {
      method: 'POST',
      path: '/mcp',
      origin: 'https://client.example.test',
      token: acceptedToken,
      body: initializeBody(),
    });
    expect(initialized.status).toBe(200);
    expect(JSON.parse(initialized.body).result.serverInfo.name).toBe('http-test');
    const sessionId = singleResponseHeader(initialized.headers, 'mcp-session-id');
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(controller.gateway.sessionCount).toBe(1);

    const hijack = await send(controller, {
      method: 'POST',
      path: '/mcp',
      origin: 'https://client.example.test',
      token: otherToken,
      sessionId,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(hijack.status).toBe(403);
    expect(JSON.parse(hijack.body).error).toBe('session_owner_mismatch');

    expect(audit.some((event) => event.type === 'session_opened' && event.sessionId === sessionId)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(acceptedToken);

    const closed = await send(controller, {
      method: 'DELETE',
      path: '/mcp',
      origin: 'https://client.example.test',
      token: acceptedToken,
      sessionId,
    });
    expect(closed.status).toBe(200);
    expect(controller.gateway.sessionCount).toBe(0);
  });

  it('fails readiness closed without exposing dependency details', async () => {
    const readinessCheck = vi.fn(async () => Promise.reject(new Error('private JWKS endpoint detail')));
    controller = createRemoteHttpServer({
      createMcpServer: () => new McpServer({ name: 'http-test', version: '1.0.0' }),
      jwtVerifier: { verify: async () => Promise.reject(new Error('unused')) },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: { allowedHosts: ['mcp.internal.test'], allowedOrigins: [] },
      readinessCheck,
    });
    await listen(controller);

    const response = await send(controller, { method: 'GET', path: '/readyz' });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toBe('not_ready');
    expect(response.headers['retry-after']).toBe('1');
    expect(response.body).not.toContain('private JWKS endpoint detail');
    expect(readinessCheck).toHaveBeenCalledOnce();
  });

  it('stops admission and closes idle connections without forcing active connections immediately', async () => {
    controller = createRemoteHttpServer({
      createMcpServer: () => new McpServer({ name: 'http-test', version: '1.0.0' }),
      jwtVerifier: { verify: async () => Promise.reject(new Error('unused')) },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: { allowedHosts: ['mcp.internal.test'], allowedOrigins: [] },
      shutdownGraceMs: 1_000,
    });
    await listen(controller);
    const closeIdleConnections = vi.spyOn(controller.server, 'closeIdleConnections');
    const closeAllConnections = vi.spyOn(controller.server, 'closeAllConnections');

    await Promise.all([controller.close(), controller.close()]);

    expect(closeIdleConnections).toHaveBeenCalled();
    expect(closeAllConnections).not.toHaveBeenCalled();
  });

  it('force-closes an incomplete active request only after the bounded shutdown grace', async () => {
    let verifierReachedResolve!: () => void;
    const verifierReached = new Promise<void>((resolve) => {
      verifierReachedResolve = resolve;
    });
    controller = createRemoteHttpServer({
      createMcpServer: () => new McpServer({ name: 'http-test', version: '1.0.0' }),
      jwtVerifier: {
        verify: async () => {
          verifierReachedResolve();
          return {
            iss: 'https://identity.example.test', aud: 'https://mcp.example.test',
            sub: 'owner', exp: nowSeconds + 600, scope: 'mcp:access',
          };
        },
      },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: { allowedHosts: ['mcp.internal.test'], allowedOrigins: [] },
      shutdownGraceMs: 1_000,
    });
    await listen(controller);
    const address = controller.server.address() as AddressInfo;
    const socket = createConnection(address.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      'POST /mcp HTTP/1.1\r\n' +
      'Host: mcp.internal.test\r\n' +
      'Authorization: Bearer accepted.payload.signature\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 100\r\n\r\n{',
    );
    await verifierReached;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeAllConnections = vi.spyOn(controller.server, 'closeAllConnections');
    const started = performance.now();

    await controller.close();

    expect(performance.now() - started).toBeGreaterThanOrEqual(850);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    await waitForSocketClose(socket);
    expect(socket.destroyed).toBe(true);
  });

  it('returns a standards-oriented bearer challenge without verifier details', async () => {
    controller = createRemoteHttpServer({
      createMcpServer: () => new McpServer({ name: 'http-test', version: '1.0.0' }),
      jwtVerifier: { verify: async () => Promise.reject(new Error('private cryptographic detail')) },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: { allowedHosts: ['mcp.internal.test'], allowedOrigins: [] },
      resourceMetadataUrl: 'https://mcp.example.test/.well-known/oauth-protected-resource',
    });
    await listen(controller);

    const metadata = await send(controller, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource',
    });
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.body)).toMatchObject({
      resource: 'https://mcp.example.test',
      authorization_servers: ['https://identity.example.test'],
      scopes_supported: ['mcp:access'],
      bearer_methods_supported: ['header'],
    });

    const response = await send(controller, {
      method: 'POST',
      path: '/mcp',
      token: acceptedToken,
      body: initializeBody(),
    });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('resource_metadata=');
    expect(response.body).not.toContain('private cryptographic detail');
  });

  it('enforces site and toolset scopes inside authenticated MCP tool calls', async () => {
    const configuration: Configuration = {
      defaultSite: 'test',
      sites: new Map([
        [
          'test',
          {
            id: 'test',
            toolsets: new Set(['discovery']),
            api: {
              baseUrl: 'https://example.test',
              tokenEnv: 'TOKEN',
              token: 'downstream-secret',
              timeoutMs: 30_000,
              maxResponseBytes: 1_000_000,
              maxPageSize: 100,
            },
          },
        ],
      ]),
    };
    controller = createRemoteHttpServer({
      createMcpServer: () => createJoomlaServer(configuration),
      jwtVerifier: {
        verify: async (token) => ({
          iss: 'https://identity.example.test',
          aud: 'https://mcp.example.test',
          sub: 'owner',
          client_id: 'owner-client',
          exp: nowSeconds + 600,
          scope:
            token === acceptedToken
              ? 'mcp:access joomla:site:test joomla:toolset:discovery'
              : 'mcp:access',
        }),
      },
      authorization: {
        issuer: 'https://identity.example.test',
        audience: 'https://mcp.example.test',
        requiredScopes: ['mcp:access'],
      },
      requestPolicy: { allowedHosts: ['mcp.internal.test'], allowedOrigins: [] },
      enableJsonResponse: true,
    });
    await listen(controller);
    const initialized = await send(controller, {
      method: 'POST',
      path: '/mcp',
      token: acceptedToken,
      body: initializeBody(),
    });
    const sessionId = singleResponseHeader(initialized.headers, 'mcp-session-id');
    const denied = await send(controller, {
      method: 'POST',
      path: '/mcp',
      token: otherToken,
      sessionId,
      body: toolCallBody(2),
    });
    expect(denied.status).toBe(200);
    expect(denied.body).toContain('not authorized for Joomla site test');

    const allowed = await send(controller, {
      method: 'POST',
      path: '/mcp',
      token: acceptedToken,
      sessionId,
      body: toolCallBody(3),
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain('"site":{"id":"test"');
    expect(allowed.body).not.toContain('downstream-secret');
  });
});

interface TestResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

async function listen(controller: RemoteHttpServerController): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    controller.server.once('error', reject);
    controller.server.listen(0, '127.0.0.1', resolve);
  });
}

async function send(
  controller: RemoteHttpServerController,
  options: {
    method: string;
    path: string;
    origin?: string;
    token?: string;
    sessionId?: string;
    body?: unknown;
  },
): Promise<TestResponse> {
  const address = controller.server.address() as AddressInfo;
  const encoded = options.body === undefined ? undefined : JSON.stringify(options.body);

  return await new Promise<TestResponse>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          Host: 'mcp.internal.test',
          Accept: 'application/json, text/event-stream',
          ...(options.origin === undefined ? {} : { Origin: options.origin }),
          ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
          ...(options.sessionId === undefined ? {} : { 'MCP-Session-Id': options.sessionId }),
          ...(encoded === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(encoded)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.once('error', reject);
    req.end(encoded);
  });
}

function initializeBody(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'remote-http-test', version: '1.0.0' },
    },
  };
}

function toolCallBody(id: number): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'joomla_capabilities', arguments: {} },
  };
}

function singleResponseHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value !== 'string') {
    throw new Error(`Expected one ${name} response header.`);
  }
  return value;
}

async function waitForSocketClose(socket: ReturnType<typeof createConnection>): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Client socket did not observe shutdown.')), 1_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
