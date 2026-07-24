import { createServer as createNodeServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { Configuration } from '../config/schema.js';
import { createJoomlaMcp } from '../library.js';
import type { LiveMcpCall, LiveMcpSession } from './types.js';

const httpIssuer = 'https://live-test.invalid';
const httpAudience = 'https://live-test.invalid/mcp';
const httpToken = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJsaXZlLXRlc3QifQ.c2lnbmF0dXJl';
const httpScopes = [
  'mcp:access',
  'joomla:sites:list',
  'joomla:permissions:grant',
  'joomla:permissions:read',
  'joomla:writes:apply',
  'joomla:sites:*',
  'joomla:toolsets:*',
] as const;

export class LiveMcpToolError extends Error {
  readonly result: unknown;

  constructor(tool: string, result: unknown) {
    super(`MCP tool ${tool} returned an error: ${toolErrorText(result)}`);
    this.name = 'LiveMcpToolError';
    this.result = result;
  }
}

export async function createStdioLiveSession(options: {
  readonly configurationFile: string;
  readonly command?: string;
  readonly arguments?: readonly string[];
}): Promise<LiveMcpSession> {
  const command = options.command ?? process.execPath;
  const args = options.arguments === undefined
    ? [fileURLToPath(new URL('../bin/joomla-mcp.js', import.meta.url))]
    : [...options.arguments];
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: process.cwd(),
    env: {
      ...stringEnvironment(),
      JOOMLA_MCP_CONFIG: resolve(options.configurationFile),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk);
    stderr.push(text);
    if (stderr.join('').length > 131_072) stderr.shift();
  });
  const client = new Client({ name: 'joomla-mcp-live-test-stdio', version: '1.0.0' });
  await client.connect(transport as unknown as Transport);

  return Object.freeze({
    kind: 'stdio',
    call: (call: LiveMcpCall) => callTool(client, call),
    close: async () => client.close(),
    diagnostics: () => Object.freeze({
      command: [command, ...args],
      stderr: stderr.join('').slice(-131_072),
      pid: transport.pid,
    }),
  });
}

export async function createHttpLiveSession(
  configuration: Configuration,
): Promise<LiveMcpSession> {
  const port = await availablePort();
  const hostname = '127.0.0.1';
  const hostHeader = `${hostname}:${port}`;
  const application = createJoomlaMcp({
    configuration,
    server: { name: 'joomla-mcp-live-test-http' },
    runtimeOptions: { audit: { write: async () => undefined } },
  });
  const controller = application.createHttpServer({
    jwtVerifier: {
      verify: async () => ({
        iss: httpIssuer,
        aud: httpAudience,
        sub: 'joomla-mcp-live-test',
        client_id: 'joomla-mcp-live-test',
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        scope: httpScopes.join(' '),
      }),
    },
    authorization: {
      issuer: httpIssuer,
      audience: httpAudience,
      requiredScopes: ['mcp:access'],
    },
    requestPolicy: {
      allowedHosts: [hostHeader],
      allowedOrigins: [],
      requireOrigin: false,
    },
    enableJsonResponse: true,
    shutdownGraceMs: 5_000,
    limits: {
      maxConcurrentRequests: 1_000,
      maxConcurrentRequestsPerPrincipal: 1_000,
      requestsPerMinutePerPrincipal: 1_000_000,
      burstPerPrincipal: 100_000,
    },
  });
  await new Promise<void>((resolveListen, reject) => {
    controller.server.once('error', reject);
    controller.server.listen(port, hostname, () => {
      controller.server.off('error', reject);
      resolveListen();
    });
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${hostHeader}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${httpToken}` } } },
  );
  const client = new Client({ name: 'joomla-mcp-live-test-http', version: '1.0.0' });
  await client.connect(transport as unknown as Transport);

  return Object.freeze({
    kind: 'http',
    call: (call: LiveMcpCall) => callTool(client, call),
    close: async () => {
      await client.close().catch(() => undefined);
      await controller.close();
    },
    diagnostics: () => Object.freeze({
      address: `http://${hostHeader}/mcp`,
      sessionId: transport.sessionId,
      serverSessions: application.runtime === undefined ? undefined : 'shared-runtime',
    }),
  });
}

async function callTool(client: Client, call: LiveMcpCall): Promise<unknown> {
  const result = await client.callTool({ name: call.name, arguments: { ...call.arguments } });
  if (result.isError === true) throw new LiveMcpToolError(call.name, result);
  return result.structuredContent ?? result.content;
}

function toolErrorText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return String(result);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  const text = content
    .map((entry) =>
      typeof entry === 'object' && entry !== null && 'text' in entry
        ? String((entry as { text: unknown }).text)
        : '')
    .filter(Boolean)
    .join(' ');
  return text || JSON.stringify(result);
}

async function availablePort(): Promise<number> {
  const server = createNodeServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => error === undefined ? resolveClose() : reject(error)));
  return port;
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
