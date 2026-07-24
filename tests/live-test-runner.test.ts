import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { runLiveTest } from '../src/live-test/runner.js';

describe('live-test runner', () => {
  it('runs catalogue CRUD through the real HTTP MCP gateway and Joomla API adapter', async () => {
    const resources = new Map<string, Map<number, Record<string, unknown>>>([
      ['v1/content/categories', new Map()],
      ['v1/content/articles', new Map()],
    ]);
    let nextId = 10;
    const server = createServer((request, response) => void handle(request, response, resources, () => ++nextId));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const directory = await mkdtemp(join(tmpdir(), 'joomla-mcp-live-runner-'));
    const configurationFile = join(directory, 'sites.json');
    await writeFile(configurationFile, `${JSON.stringify({
      defaultSite: 'fixture',
      approval: {
        secretEnv: 'LIVE_TEST_APPROVAL_SECRET',
        ttlMs: 300000,
        requestTtlMs: 300000,
      },
      sites: {
        fixture: {
          toolsets: ['discovery', 'content.read', 'content.write', 'structure.read', 'structure.write'],
          api: {
            baseUrl: `http://127.0.0.1:${port}`,
            tokenEnv: 'LIVE_TEST_API_TOKEN',
            allowInsecureLoopback: true,
          },
        },
      },
    }, null, 2)}\n`);
    const oldToken = process.env['LIVE_TEST_API_TOKEN'];
    const oldApproval = process.env['LIVE_TEST_APPROVAL_SECRET'];
    process.env['LIVE_TEST_API_TOKEN'] = 'fixture-token';
    process.env['LIVE_TEST_APPROVAL_SECRET'] = 'fixture-approval-secret-with-at-least-32-characters';

    try {
      const summary = await runLiveTest({
        configurationFile,
        site: 'fixture',
        outputDirectory: join(directory, 'evidence'),
        profile: 'crud',
        joomlaPaths: ['api'],
        mcpTransports: ['http'],
        families: ['content'],
        nonInteractive: true,
        confirmMutations: true,
        disposable: true,
        cleanup: true,
        retainDemo: false,
        failFast: false,
        seed: 'unit-test',
      });

      expect(summary.exitCode).toBe(0);
      expect(summary.counts.FAIL).toBe(0);
      expect(summary.counts.CLEANUP_FAILED).toBe(0);
      expect(summary.counts.PASS).toBeGreaterThanOrEqual(14);
      expect(resources.get('v1/content/articles')?.size).toBe(0);
      expect(resources.get('v1/content/categories')?.size).toBe(0);
      expect(await readFile(join(directory, 'evidence', 'summary.md'), 'utf8')).toContain('Result: **PASS**');
    } finally {
      if (oldToken === undefined) delete process.env['LIVE_TEST_API_TOKEN'];
      else process.env['LIVE_TEST_API_TOKEN'] = oldToken;
      if (oldApproval === undefined) delete process.env['LIVE_TEST_APPROVAL_SECRET'];
      else process.env['LIVE_TEST_APPROVAL_SECRET'] = oldApproval;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  resources: Map<string, Map<number, Record<string, unknown>>>,
  nextId: () => number,
): Promise<void> {
  if (request.headers.authorization !== 'Bearer fixture-token') {
    json(response, 401, { errors: [{ detail: 'unauthorized' }] });
    return;
  }
  const url = new URL(request.url ?? '/', 'http://fixture');
  const route = url.pathname.replace('/api/index.php/', '');
  const collection = [...resources.keys()].find((candidate) =>
    route === candidate || route.startsWith(`${candidate}/`));
  if (collection === undefined) {
    json(response, 404, { errors: [{ detail: `unknown route ${route}` }] });
    return;
  }
  const records = resources.get(collection)!;
  const suffix = route.slice(collection.length).replace(/^\//u, '');
  const id = suffix === '' ? undefined : Number(suffix);

  if (request.method === 'GET' && id === undefined) {
    json(response, 200, {
      data: [...records.entries()].map(([recordId, attributes]) => ({ id: String(recordId), attributes })),
    });
    return;
  }
  if (request.method === 'GET' && Number.isSafeInteger(id)) {
    const attributes = records.get(id!);
    if (attributes === undefined) {
      json(response, 404, { errors: [{ detail: 'not found' }] });
      return;
    }
    json(response, 200, { data: { id: String(id), attributes } });
    return;
  }
  if (request.method === 'POST') {
    const body = await bodyRecord(request);
    const recordId = nextId();
    records.set(recordId, body);
    json(response, 201, { data: { id: String(recordId), attributes: body } });
    return;
  }
  if (request.method === 'PATCH' && Number.isSafeInteger(id)) {
    const current = records.get(id!);
    if (current === undefined) {
      json(response, 404, { errors: [{ detail: 'not found' }] });
      return;
    }
    const body = await bodyRecord(request);
    const updated = { ...current, ...body };
    records.set(id!, updated);
    json(response, 200, { data: { id: String(id), attributes: updated } });
    return;
  }
  if (request.method === 'DELETE' && Number.isSafeInteger(id)) {
    records.delete(id!);
    response.writeHead(204);
    response.end();
    return;
  }
  json(response, 405, { errors: [{ detail: 'method not allowed' }] });
}

async function bodyRecord(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/vnd.api+json' });
  response.end(JSON.stringify(value));
}
